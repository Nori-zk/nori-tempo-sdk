# Tempo: nori-bridge-tempo-sdk

TypeScript SDK for the Nori Ethereum→Tempo proof queue. An Ethereum contract enqueues a storage-proof request on [NoriProofRequestQueue.sol](../ethereum/contracts/NoriProofRequestQueue.sol); Nori's bridge infrastructure proves it and commits the batch that settled it on Tempo, in [NoriTempoTokenBridge.sol](../tempo/contracts/NoriTempoTokenBridge.sol). This SDK follows a request from the transaction that enqueued it until its batch is committed, builds the request's Merkle witness against that batch root, shows a submitting address's requests as a paged history or a live view, shows the bridge's batches and the requests waiting for one, and follows Nori's prover pipeline as it works.

The SDK is built on RxJS: every function returns an observable, and everything that changes over time is a state machine.


## Install

```sh
npm install @nori-zk/nori-bridge-tempo-sdk
```

The witness hashing comes from `@nori-zk/ethereum-tempo-proof-queue-utils-glam`, the SP1 guest's own hashing compiled to WebAssembly, installed as a dependency.

The package has three entry points:

- `@nori-zk/nori-bridge-tempo-sdk`: everything below;
- `@nori-zk/nori-bridge-tempo-sdk/utils`: `stateOf$`, `dataOnEntry$`, `atNode`, `AsNodeData` and `StartedMachine`, for an app's own YState machines;
- `@nori-zk/nori-bridge-tempo-sdk/program`: the Tempo contracts' ethers types, factories and ABIs (`NoriTempoTokenBridge__factory` and the rest of `@nori-zk/tempo-token-bridge`).

## How a proof request gets proven

A request enqueued on Ethereum waits for Ethereum to finalize its block. Nori's bridge head then takes the requests enqueued since the last batch as one job, proves Ethereum's state with SP1, and its Tempo processor submits the proof to the bridge contract on Tempo in an `update`, which commits the batch: the queue cursor moves past the requests, and, when the job had any, the contract records their Merkle root as the next proof queue batch. Nori publishes each step as it happens, and the SDK follows them with this machine:

![Nori bridge infra transition graph](src/rpc/nori/NoriBridgeInfraTransitionGraph.svg)

- `BridgeHeadJobCreated`: the bridge head has taken the next requests as a job.
- `BridgeHeadJobSucceeded`: their proof is done; its data lists the requests it covers (`verified_requests`). A failed job (`BridgeHeadJobFailed`) is staged again.
- `EthProcessorTransactionSubmitting`, then `…SubmitSucceeded` (with the Tempo transaction) or `…SubmitFailed`.
- `…FinalizationSucceeded` or `…FinalizationFailed`: whether the `update` landed on Tempo, where a mined transaction is final. After a failure the bridge head checks the contract: still aligned, it stages the job again; moved on, it advances.
- `BridgeHeadAdvanced`: the batch is committed; the next job follows.
- `BridgeHeadStarted` and `EthProcessorStarted`: a restart, which resumes from its checkpoint.
- `joining`: connected, before the first step arrives. It carries Nori's latest summary of the stage, and every reconnect comes back here, since steps sent while disconnected are lost.

Each state carries that step's data exactly as Nori sent it. Nori reports these states itself, so this machine is not driven by the SDK. `createConnections` starts following it once for the app, on its one Nori websocket, and `getNoriBridgeInfraTransitions(nori)` gives that instance:

```ts
import { getNoriBridgeInfraTransitions } from '@nori-zk/nori-bridge-tempo-sdk';

const { noriBridgeInfraTransitions, stage$, finalityTransitions$, warnings$ } =
    getNoriBridgeInfraTransitions(nori);

noriBridgeInfraTransitions.state$.subscribe(({ node, data }) => {
    if (node === 'BridgeHeadJobSucceeded') console.log('Proven:', data.verified_requests);
});
stage$.subscribe(({ stage, sinceMs }) => console.log(`${stage} since ${new Date(sinceMs).toISOString()}`));
```

`stage$` is the stage the pipeline is at and since when. Nori sends its steps live only, so `stage$` takes its position from Nori's `state.bridge`, which the server sends on every (re)connect with the time already spent in the stage, and moves on with each step; a subscriber joining at any time gets the stage the pipeline is at. `finalityTransitions$` emits each time the bridge head sees Ethereum finality move on, and `warnings$` its warnings: events during any step, not steps themselves.

## State machines

Everything that changes over time is a state machine built with [YState](https://github.com/yaw-rx/ystate), a small library of finite state machines over RxJS. A machine is a graph: named states (nodes), each carrying its own data, and the moves between them (edges), each made when something happens, such as a read finishing or a timer firing. The graphs in this README are the machines' exact definitions, and each machine's state type is derived from its graph (`StateUnion<typeof Graph.nodes>`).

The transports' machines, the connections' status machines and every reading machine are returned running, with a `close()` that moves the machine to its `closed` state and ends its streams. A reading machine is the running machine itself, with its controls on it: `close()`, `retry()` to read again at once while failed, and its own, such as the history's `loadMore()`. The unprocessed request's machine is returned ready to run: `.close().start(firstState)` runs it, and `.stop()` ends it.

A running machine has:

- `state$`: emits `{ node, data }` each time it moves, starting with where it is now;
- `event$`: emits `{ edge, from, to }` for each move;
- `status$`: `running`, `complete`, `error` or `stopped`.

### A value read through the connections

![Read through connections graph](src/rpc/connection/ReadThroughConnectionsGraph.svg)

Every value the SDK reads from the chains goes through the same states: the proof request and its witness, the paged history, the live view, the bridge's batches, a batch's requests, the bridge's state, the committed batches, Ethereum's blocks, the queue's head, a transaction's receipt (also the end of a transaction sent through the wallet or a signer), the wallet's account, and the token bridge's minted amounts, mirrors, pause states, balances and fee tokens. Each of their graphs is `readThroughConnectionsOf(data)`, given the data the value holds, with any states of its own added.

- `loading` reads the value. It carries the data already on screen: empty before the first read.
- `current` holds the value until a refresh is due: a new block, a log, a signal from Nori, a timer, or a call such as `loadMore()`, depending on the machine. What makes it due is followed from before each read starts, and the read waits until it is following (a chain trigger once it knows the block it starts from), so a change while the value is being read is not missed: it makes a refresh due as soon as the value arrives.
- `refreshing` reads the value again while still holding it.
- A read that fails to reach a connection reports it to that connection, which checks itself again, and the machine stays where it is until the check settles: a connection that turns out to be down is a lost connection; one that passes straight back means the read itself failed.
- `waitingForConnectionWhileLoading` and `waitingForConnectionWhileRefreshing` name the chains (or the one transport, such as `ethereum.wallet`) they wait on in `data.waitingOn`, updated as they change, and read again once those can serve a read.
- `failedWhileLoading` and `failedWhileRefreshing` hold the error in `data.error` and read again by themselves after a wait that doubles with each failure in a row (`data.failedReads`); `retry()` reads again at once. A read that arrives resets `data.failedReads`.
- `closed` is terminal.

Nothing is a dead end: a lost connection is waited for, and a failure retries itself.

## Connections

The app names the transports it has, once, and `createConnections` opens them, each with its own machine:

```ts
import { createConnections } from '@nori-zk/nori-bridge-tempo-sdk';

const { network, ethereum, tempo, nori, close } = createConnections({
    ethereum: {
        expectedChainId: 11155111n,
        http: { rpcUrl: 'https://…' }, // optional
        websocket: { url: 'wss://…' }, // optional
        wallet: true, // optional: the user's browser wallet
        order: {
            calls: ['http', 'wallet'],
            logs: ['http', 'wallet'],
            subscriptions: ['websocket', 'wallet'],
        },
    },
    tempo: {
        network: 'moderato', // or 'mainnet'; or { expectedChainId, http: { rpcUrl } } for any other Tempo chain
        http: { rpcUrl: 'https://…' }, // optional: default, the network's public URL
        websocket: { url: 'wss://…' }, // optional: default, the http URL over wss
        wallet: true, // optional: only for the app's own Tempo transactions
    },
    nori: { websocket: { url: 'wss://…' } }, // optional: default, wss://wss.tempo.nori.it.com
    healthChecks: { intervalMs: 5_000, timeoutMs: 3_000 }, // optional, for every transport
    requests: { timeoutMs: 10_000 }, // optional: an http request taking longer fails and re-checks its transport
    retries: { initialDelayMs: 1_000, maxDelayMs: 30_000 }, // optional, for every transport
});
```

Every call with the same options gets the same connections: the same transports, machines and Nori websocket. Nori runs several websocket servers, each with its own cached state, so the whole app reads Nori through one socket. Each caller's `close()` releases its hold, and the connections close once every caller has closed.

What comes back has one object per transport, and a status per chain:

| Object               | Has                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `network`            | `connection`, `status`                                                                       |
| `ethereum`           | `status`, `http`, `websocket`, `wallet`                                                      |
| `ethereum.http`      | `connection`, `close()`                                                                      |
| `ethereum.websocket` | `connection`, `socket`, `close()`                                                            |
| `ethereum.wallet`    | `connection`, `ready$(): Observable<BrowserProvider>`, `chooseWallet(uuid)`, `switchToExpectedChain()`, `close()` |
| `tempo`              | as `ethereum`, over Tempo's transports                                                       |
| `nori`               | `status`, `websocket`, `transitions`, `bridgeState$`, `finality$`                            |

`connection` is the transport's running machine (`undefined` for a transport the app left out). Reads go through the machines below, never through a transport directly. The wallet's `ready$()` emits its `BrowserProvider` once, when the wallet is ready, to sign with; otherwise it errors at once with `ConnectionNotReadyError`, whose `notReady` lists the wallet's state, or with `NoWalletConfiguredError` when the app gave no wallet: a setup mistake, not a state to wait out. `nori.bridgeState$` and `nori.finality$` are Nori's `state.bridge` and `state.eth`, each stamped with when it arrived (`{ value, atMs }`), so a time inside it ages from its arrival. `close()` on the top level releases the connections.

### Status

![Connection status graph](src/rpc/connection/ConnectionStatusGraph.svg)

`network.status`, `ethereum.status`, `tempo.status` and `nori.status` each hold a running machine (`connection`) that says whether that connection can serve requests, over its transports in its calls order:

- `connected`: a transport is up; `data.transport` names the first one up in the order (`ethereum.http`, …).
- `unsure`: no transport is up, and one has no outcome yet or has failed only once in a row and is checking again.
- `down`: no transport is up or unsure; `data.reason` is the state of the first transport's machine (`unreachable`, `offline`, `wrongNetwork`, …).

Any of the three moves to any other as the transports change. An app shows these as they are, e.g. green, blue and red. A wallet's own status comes from `walletStatus('ethereum.wallet')` over `ethereum.wallet.connection.state$`, and `createConnectionStatusMachine` builds a status machine over any transports, with `httpStatus`, `websocketStatus`, `walletStatus` and `networkStatus` turning each transport's states into statuses.

### Which transport serves what

Calls, log queries and subscriptions can each go over more than one Ethereum transport, in the order the app gives in `order`; the SDK sets none. When only one configured transport can serve a kind of request, that one is used; when several can and no order is given, `createConnections` throws. Signing only ever goes through the wallet: `ethereum.wallet.ready$()` gives its `BrowserProvider`, whose `getSigner()` signs. Tempo is the same kind of chain object over Tempo's transports. By default each kind of request has one transport there: calls and logs over http, subscriptions over the websocket; `tempo.order` changes that. Its wallet serves only the app's own Tempo transactions, since a browser wallet is on one chain at a time and the app signs its Ethereum transactions through it.

Every machine and stream below takes the connections or a chain object (`ethereum`, `tempo`, `nori`) and picks the transport itself. A read runs on the first ready transport in its chain's calls order, or logs order for Ethereum's log queries. When a request in it fails to reach its node, it tells that transport and runs the read again from the start on the next ready one, so one run never mixes nodes. An app's own values are read the same way, as machines (see [An app's own values](#an-apps-own-values)).

The machines read again when the chain changes: on new blocks and on the contracts' logs. They subscribe to those on the first ready transport in the subscriptions order (the websocket, or the wallet's own `eth_subscribe` where the wallet supports it), move to the next when that one stops being ready and back when a higher one recovers, and while none is ready poll through the calls order.

### Network

![Network graph](src/rpc/connection/NetworkGraph.svg)

Whether the device can reach the internet, in a browser or in Node. It checks for itself by requesting a few well-known endpoints (any one answering means online; set your own with `network.probeUrls`), because a browser reports being online on a network with no internet. The browser's own online and offline events only make it check sooner. While `offline`, every transport pauses, and when it comes back `online` they check again at once.

### HTTP

![HTTP connection graph](src/rpc/connection/HttpConnectionGraph.svg)

Ethereum's and Tempo's http transports. `ready` means a health check passed on the expected network: `eth_chainId` then `eth_blockNumber` (`data.health.blockNumber`). While ready it checks again in the background. `unreachable` and `wrongNetwork` (the endpoint serves another chain; `data.found` and `data.expected` say which) check again after a wait that doubles each time, so an endpoint that comes back, or is fixed, recovers by itself. `data.url` says which endpoint each state is about. A request that fails to reach the node makes it check at once.

### WebSocket

![WebSocket connection graph](src/rpc/connection/WebSocketConnectionGraph.svg)

Ethereum's, Tempo's and Nori's websockets. `open` means the socket is connected; a socket that closes, errors or stops answering its heartbeat (Nori's ping and pong) drops to `reconnecting`, which connects again after a wait that doubles each time. A subscription is sent again every time the socket opens. `gaveUp` is reached only when `retries.maxAttempts` is set and runs out; the socket's `retry()` starts again. Messages sent while connecting are queued until the socket opens.

### Ethereum wallet

![Ethereum wallet graph](src/rpc/eth/EthereumWalletGraph.svg)

The user's wallet, found through EIP-6963 (with the older `window.ethereum` as a fallback). Its `checking`, `ready`, `wrongNetwork`, `unreachable`, `offline` and `closed` states, with their moves, are the same checked connection as http's (`healthCheckedOf`), each carrying the wallet, so the app gates on it exactly as on http; `data.url` is the wallet's reverse-DNS id (e.g. `io.metamask`). Unlike an RPC URL, a wallet on another chain is not checked again on a timer: it waits for the user to change chain.

| State                 | What it means                                                                        | What the app can do                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `lookingForWallets`   | Asking installed wallets to announce themselves.                                     | Wait.                                                                                                 |
| `noWalletFound`       | No wallet is installed. A wallet installed or enabled later is picked up.            | Ask the user to install one.                                                                          |
| `choosingWallet`      | Several wallets are installed; `data.wallets` lists them (name, icon).               | Let the user pick, then `ethereum.wallet.chooseWallet(uuid)`.                                         |
| `checking`            | Asking the wallet for its chain, then its latest block.                              | Wait.                                                                                                 |
| `ready`               | Ready to use; `data.health.blockNumber` is the latest block.                         | Nothing.                                                                                              |
| `wrongNetwork`        | The wallet is on chain `data.found`, not `data.expected`.                            | Ask the user to switch, or call `ethereum.wallet.switchToExpectedChain()` to have the wallet ask them. |
| `askingToSwitchChain` | The wallet is showing the switch request.                                            | Ask the user to confirm it.                                                                           |
| `switchDeclined`      | The user said no. The wallet is not asked again until they change chain themselves.  | Tell them they can switch in their wallet whenever they're ready.                                     |
| `unreachable`         | The wallet did not answer, or disconnected; it is asked again after a wait.          | Wait; the wallet's status is `down`.                                                                  |
| `offline`             | The device is offline.                                                               | Wait.                                                                                                 |

A switch request the wallet fails for another reason (e.g. it doesn't know the chain) returns to `wrongNetwork` with the wallet's error in `data.lastSwitchError`. Any chain change, in any state with a wallet, checks again.

```ts
ethereum.wallet.connection?.state$.subscribe(({ node }) => {
    if (node === 'noWalletFound') console.log('Install a wallet such as MetaMask to continue.');
    if (node === 'wrongNetwork') console.log('Switch your wallet to Sepolia.');
    if (node === 'askingToSwitchChain') console.log('Confirm the switch in your wallet.');
});
```

#### The wallet's account

![Wallet account graph](src/rpc/eth/WalletAccountGraph.svg)

`ethereum.wallet.account` (and `tempo.wallet.account`, when Tempo has a wallet) is the account the wallet shares with the app, read through the wallet alone: `eth_accounts`, which never prompts the user, read again on the wallet's `accountsChanged`. `current` holds `data.account`, `undefined` while none is shared. While the wallet is not `ready`, it waits for it (`waitingOn: ['ethereum.wallet']`).

| State                  | What it means                                                                                  | What the app can do                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `current`              | `data.account` is the shared account, or `undefined`.                                          | With no account, `ethereum.wallet.account.shareAccount()` asks the user. |
| `askingToShareAccount` | The wallet is showing the request (`eth_requestAccounts`).                                     | Ask the user to confirm it.                                      |
| `shareDeclined`        | The user said no. Connecting from inside the wallet still moves it on.                         | `shareAccount()` asks again when the user clicks.                |

Another failure of the request (e.g. one already pending) goes back to `current`, with the wallet's error in `data.lastShareError` for logs; the app shows the state, not the text.

## Chain changes

![Chain changes graph](src/rpc/connection/ChainChangesGraph.svg)

Whether a chain has changed: a new block, or a log matching a filter. It is what the machines read again on, and an app's own machine can too. `createChainChangesMachine(connections.tempo, { address, topics })` (or `createChainChangesMachine(connections.ethereum)` for every new block) starts one; whoever starts it owns it and closes it. A reading machine gates on it with `changesOf$(changes)`, which emits once the machine follows the chain, then once per change, and starts nothing.

- `subscribed`: subscribed on the first transport in the chain's subscriptions order that is usable and serves the subscription; the node's acknowledgement (`acknowledged`) is where it starts following, and each push after it is a change. A transport that refuses the subscription (a wallet without `eth_subscribe`) is recorded in `unsupported` and passed over.
- `polling`: no transport can subscribe; it polls the calls order every interval (5 s by default). `lastBlock` is the last block polled; the first poll, sent at once, is where it starts following. After a gap longer than one log query it moves on to the latest block and counts one change instead of reading the gap.
- `pollFailed`: a poll failed; it polls again after the interval, or subscribes once a transport can.
- Moving between subscribing and polling counts a change, as one may fall between the two.

## Nori's topics

Nori publishes its state on its websocket:

| Topic |
| --- |
| `noriBridgeInfraState$(nori)` |
| `noriBridgeInfraTimings$(nori)` |
| `noriBridgeInfraEthState$(nori)` |
| `noriBridgeInfraTransitionNotices$(nori)` |
| `noriBridgeInfraSystemNotices$(nori)` |
| `noriBridgeInfraStateWithTimings$(nori)` |

They only exist on Nori's websocket, so they have no polling; its state, timings and Ethereum state replay the latest to each new subscriber.

## Values kept current

### The bridge's state

![Bridge state graph](src/proofQueue/BridgeStateGraph.svg)

`createBridgeStateMachine({ ethereum, tempo }, bridgeAddress)` reads the Tempo bridge's `state()` (queue cursor, batch count, latest proven head and root) through Tempo, holds it in `current` as `data.bridgeState`, and reads it again each time an `update` is applied (`UpdateApplied`).

### Ethereum's blocks

![Ethereum blocks graph](src/proofQueue/EthereumBlocksGraph.svg)

`createEthereumBlocksMachine({ ethereum, tempo })` reads Ethereum's latest and finalized blocks through Ethereum, holds them in `current` as `data.latestBlock` and `data.finalizedBlock`, and reads them again on each new block. A proof request is proven only once its block is finalized.

### The committed batches

![Committed proof queue batches graph](src/proofQueue/CommittedProofQueueBatchesGraph.svg)

`createCommittedProofQueueBatchesMachine({ ethereum, tempo }, bridgeAddress, fromBlock?)` reads each proof queue batch the bridge commits from its `ProofQueueBatchCommitted` logs, and reads again each time it commits one. `current` holds `data.committed`, the batches committed in the blocks the last read covered (each with its index, root, cursors, Tempo block and transaction); each read starts after the last block read (`data.lastBlock`), so every batch arrives once. The first read covers `fromBlock` (default: the latest block) to the latest block.

### The queue's head

![Proof queue head graph](src/proofQueue/ProofQueueHeadGraph.svg)

`createProofQueueHeadMachine({ ethereum, tempo }, proofQueueAddress)` reads the queue's `head` (how many proof requests have ever been enqueued, which is also the next request's id) through Ethereum, holds it in `current` as `data.head`, and reads it again on each `ProofRequested` the queue emits.

### A transaction's receipt

![Transaction receipt graph](src/rpc/connection/TransactionReceiptGraph.svg)

`createTransactionReceiptMachine({ ethereum, tempo }, chain, transactionHash)` reads a transaction's receipt through `chain` (`'ethereum'` or `'tempo'`) and reads it again on each new block of that chain until the transaction is mined. `current` holds `data.receipt`: `undefined` until mined, then `{ transactionHash, blockNumber, status }`, which is not read again. On Tempo a mined transaction is final.

## Following one proof request

![Proof request state graph](src/proofRequest/ProofRequestStateGraph.svg)

`createProofRequestStateMachine` follows the request from the transaction that enqueued it until its proof is available. While it follows the request, its value is the request's snapshot, `data.snapshot`, whose `state` says where the request is:

- `undetermined`: not found yet. `loading` looks the request up on Ethereum; a transaction that is not mined yet leaves it `undetermined`, and it is looked up again every poll interval (15 s by default) and on every recheck signal.
- `unprocessed`: the bridge has not proven it yet. It is read again every poll interval and on every recheck signal, such as Nori's stage moving on.

A read that finds a committed proof queue batch covering the request moves to the terminal node `proofAvailable`. Its `data.snapshot` carries that batch: `proofQueueBatchIndex`, `tempoBlockNumber` (the Tempo block whose `update` committed it), its root, cursors and output blocks, and the request's `indexInBatch`. Batches are append-only, so it is never read again.

Lost connections and failed reads are the waiting and failed states above. To resume a request whose snapshot the app already knows, pass it as the third argument: an `undetermined` or `unprocessed` one starts in `current`, a proven one in `proofAvailable`, instead of looking the request up.

### The proven request's witness

![Proof request witness graph](src/proofRequest/ProofRequestWitnessGraph.svg)

Once the snapshot is `proofAvailable`, `createProofRequestWitnessMachine(connections, proofQueueAddress, proofAvailable)` reads every request in its batch from Ethereum's logs, rebuilds the batch's Merkle tree, and checks it against the root committed on Tempo (a mismatch is a failed read, `ProofRequestWitnessRootMismatchError`). `current` holds `data.witness`, the request's leaf, its bottom-up path and the root, and `data.verifiedWitness`, the same in the shape the Tempo contracts take (`mintCall`, `mintERC20Call`, `applyPauseCall`). A committed batch never changes, so the witness is never read again.

```ts
import { filter, map, switchMap, take } from 'rxjs';
import {
    createConnections,
    createProofRequestStateMachine,
    createProofRequestWitnessMachine,
    noriBridgeInfraState$,
    type ProofRequestStateNodeUnion,
    type ProofRequestWitnessState,
} from '@nori-zk/nori-bridge-tempo-sdk';

const { ethereum, tempo, nori } = createConnections({
    ethereum: { expectedChainId: 11155111n, http: { rpcUrl: 'https://…' } },
    tempo: { network: 'moderato' },
});
const proofQueueAddress = '0x…'; // the NoriProofRequestQueue address
const bridgeAddress = '0x…'; // the NoriTempoTokenBridge address
const proofRequestTxHash = '0x…'; // the transaction that enqueued the request

const proofRequestState = createProofRequestStateMachine(
    { ethereum, tempo },
    { proofQueueAddress, bridgeAddress, proofRequestTxHash },
    undefined,
    15_000,
    noriBridgeInfraState$(nori) // read again whenever the bridge moves on
);

// The witness machine's states, once the request's proof is available.
const witnessState$ = proofRequestState.state$.pipe(
    filter(
        (state): state is Extract<ProofRequestStateNodeUnion, { node: 'proofAvailable' }> =>
            state.node === 'proofAvailable'
    ),
    map(({ data }) => data.snapshot),
    take(1),
    switchMap(
        (proofAvailable) =>
            createProofRequestWitnessMachine({ ethereum, tempo }, proofQueueAddress, proofAvailable).state$
    )
);
const verifiedWitness$ = witnessState$.pipe(
    filter((state): state is Extract<ProofRequestWitnessState, { node: 'current' }> => state.node === 'current'),
    map(({ data }) => data.verifiedWitness)
);
```

### While unprocessed: what it is waiting on

![Unprocessed proof request state graph](src/proofRequest/UnprocessedProofRequestStateGraph.svg)

Nori's bridge infra state says what an unprocessed request is waiting on: Ethereum finality for its block, the job ahead of it, then the job that includes it. `createUnprocessedProofRequestStateMachine(blockNumber, nori)` follows these from the request's block number and Nori's state, timings and Ethereum state. Every new `state.eth`, `state.bridge` or timings message recomputes where the request waits and how long it has left, and the estimate counts down each second in between. Each state's data carries `time_remaining_sec` for the step it is in, `commit_time_remaining_sec` until the batch covering the request is committed on Tempo (negative once that is taking longer than expected), and `waiting_elapsed_sec` for how long it has been in that state, which together draw a progress bar.

Nori creates a job on each Ethereum finality transition, one epoch (`ETHEREUM_EPOCH_SEC`, 384 s) after the last, proving the epoch's blocks, and commits it on Tempo when it finishes; a job takes at most `MAX_BATCH_SIZE` (2¹⁶) requests. A job goes through the stages in `NORI_JOB_STAGES`: proving it (`BridgeHeadJobCreated`, `BridgeHeadJobSucceeded`), then submitting it to Tempo (`EthProcessorTransactionSubmitting`, `EthProcessorTransactionSubmitSucceeded`); it is committed when it reaches `EthProcessorTransactionFinalizationSucceeded`. `getCommitTimes(stage, timings)` gives, from where Nori is in its loop, the seconds until the job it is running is committed and until the next job is committed. `jobTimingsOf(timings)` gives the seconds each job stage takes: Nori's timings where it reports them, and `FALLBACK_NORI_JOB_TIMINGS` (a proof about two minutes, submitting to Tempo about a second) otherwise. `getFinalityTimeRemainingSec(blockNumber, finality)` gives the seconds until a block is finalized.

## The bridge's batches and the waiting requests

![Proof queue batches graph](src/proofQueue/ProofQueueBatchesGraph.svg)

`createProofQueueBatchesMachine` keeps a live view of the bridge's newest proof queue batches and the requests no batch covers yet, for every submitting address or one (`target`). The view, `data.view`, holds `batches` (newest first, each with the target's request ids in it as `matching`), `waiting` (oldest first), `batchCount`, `queueCursor`, and Ethereum's `finalizedBlock` and `latestBlock`.

The bridge's state and Ethereum's blocks come from their machines, which the app passes in (`sources`) and can share with other views. The view reads once both are `current`, fails while either has failed, and waits while either waits for its connection. It refreshes when the bridge's batch count or queue cursor changes, on each Ethereum block past the view, when a source waits or fails, and on each recheck signal.

`sortWaitingProofRequests(waiting, finalizedBlock, job?)` sorts the waiting requests into three sets, each oldest first: those whose block is not finalized yet, those finalized and scheduled for a later job, and those in the job Nori is running now. The first two come from Ethereum and Tempo alone. Telling the job Nori is running apart from the later ones needs Nori's `state.bridge`; without it, every finalized request is scheduled.

```ts
import { combineLatest, filter, map, startWith } from 'rxjs';
import {
    createBridgeStateMachine,
    createEthereumBlocksMachine,
    createProofQueueBatchesMachine,
    sortWaitingProofRequests,
    type ProofQueueBatchesState,
} from '@nori-zk/nori-bridge-tempo-sdk';

const bridgeState = createBridgeStateMachine({ ethereum, tempo }, bridgeAddress);
const ethereumBlocks = createEthereumBlocksMachine({ ethereum, tempo });
const proofQueueBatches = createProofQueueBatchesMachine(
    { ethereum, tempo },
    { proofQueueAddress, bridgeAddress },
    { fromBlock: queueDeploymentBlock, count: 10 },
    { bridgeState, ethereumBlocks },
    nori.transitions.stage$ // and refresh whenever Nori's stage moves on
);

const waiting$ = combineLatest([
    proofQueueBatches.state$.pipe(
        filter((state): state is Extract<ProofQueueBatchesState, { node: 'current' }> => state.node === 'current')
    ),
    nori.bridgeState$.pipe(map(({ value }) => value), startWith(undefined)),
]).pipe(map(([{ data }, job]) => sortWaitingProofRequests(data.view.waiting, data.view.finalizedBlock, job)));
```

![Proof queue batch requests graph](src/proofQueue/ProofQueueBatchRequestsGraph.svg)

`createProofQueueBatchRequestsMachine(connections, proofQueueAddress, batch, query)` reads one committed batch's requests (the target's only, when given) over the batch's own block and request id range. A committed batch never changes, so they are never read again.

## A submitting address's requests

The submitting address is the contract that enqueued the requests: the queue records `msg.sender` as each request's `target`. Its requests are found from the queue's `ProofRequested` logs, filtered on `target`, in block ranges small enough for providers' limits, from `fromBlock` (e.g. the queue's deployment block). Each request comes back with its snapshot: `unprocessed`, or `proofAvailable` with the batch covering it, ready for `createProofRequestWitnessMachine`.

### Paged history

![Proof request history graph](src/proofRequest/ProofRequestHistoryGraph.svg)

```ts
import { createConnections, createProofRequestHistoryMachine } from '@nori-zk/nori-bridge-tempo-sdk';

const { ethereum, tempo } = createConnections({
    ethereum: { expectedChainId: 11155111n, http: { rpcUrl: 'https://…' } },
    tempo: { network: 'moderato' },
});
const proofQueueAddress = '0x…'; // the NoriProofRequestQueue address
const bridgeAddress = '0x…'; // the NoriTempoTokenBridge address
const submittingAddress = '0x…'; // the contract that enqueued the requests
const queueDeploymentBlock = 0; // the block the queue was deployed in

const proofRequestHistory = createProofRequestHistoryMachine(
    { ethereum, tempo },
    { proofQueueAddress, bridgeAddress },
    { target: submittingAddress, fromBlock: queueDeploymentBlock, order: 'desc', pageSize: 20 }
);

proofRequestHistory.loadMore(); // the next page, while current
```

The first page loads at once. `current` holds the requests loaded so far in `data.loaded`, newest first with `desc` or oldest first with `asc`, and `loadMore()` reads the next page (`refreshing`), appended to them. The page that exhausts the block range moves to `allLoaded`.

### Live view of the newest requests

![Latest proof requests graph](src/proofRequest/LatestProofRequestsGraph.svg)

```ts
import { createLatestProofRequestsMachine } from '@nori-zk/nori-bridge-tempo-sdk';

const latestProofRequests = createLatestProofRequestsMachine(
    { ethereum, tempo },
    { proofQueueAddress, bridgeAddress },
    { target: submittingAddress, fromBlock: queueDeploymentBlock, count: 10 },
    15_000, // refresh interval
    nori.transitions.stage$ // and refresh whenever Nori's stage moves on
);
```

It shows the newest `count` requests in `data.view` and keeps them current: new requests enter at the top, and requests move from `unprocessed` to `proofAvailable` as the bridge commits their batches. A request that an Ethereum reorg removes leaves the view (`requestDroppedByReorg`), which loads again from `fromBlock` and refills from older blocks, keeping the view on screen meanwhile. It never ends on its own.

## An app's own values

A value of the app's own, such as a read of its own contract, is a machine too: its graph spreads `readThroughConnectionsOf`, given the data the value holds, and `startReadThroughConnectionsMachine` starts it, the way every machine in the SDK is started. The read is given `clients`, one runner per chain, and runs only inside the machine; the machine waits out lost connections and retries failed reads as described in [A value read through the connections](#a-value-read-through-the-connections).

```ts
import { define } from '@yaw-rx/ystate';
import { Contract } from 'ethers';
import { defer, map, NEVER } from 'rxjs';
import { dueOn, readThroughConnectionsOf, startReadThroughConnectionsMachine } from '@nori-zk/nori-bridge-tempo-sdk';

const TokenSymbolGraph = define(readThroughConnectionsOf({ symbol: undefined as string | undefined }));

const tokenSymbol = startReadThroughConnectionsMachine(TokenSymbolGraph, {
    connections: { ethereum, tempo },
    read: (clients) =>
        clients
            .ethereum((provider) =>
                defer(() => new Contract(token, ['function symbol() view returns (string)'], provider).symbol())
            )
            .pipe(map((symbol: string) => ({ symbol }))),
    refreshOn: () => dueOn(NEVER), // a token's symbol never changes
    needs: ['ethereum'],
});
```

`refreshOn` says when the value is due to be read again. It is followed from before each read: its first emission says it is following, and each later one that a refresh is due. A change on a chain is `changesOf$(changes)` of a chain changes machine the reading machine's creator starts and passes in `owns`, so the reading machine's `close()` closes it too (see [Chain changes](#chain-changes)); it says it is following once that machine knows the block it starts from; a trigger with no starting point (a timer, a signal, a Nori topic) goes through `dueOn(trigger$)`, and a value that cannot change uses `dueOn(NEVER)`. `needs` names the chains the read goes through (both by default), or one transport such as `'ethereum.wallet'`, which the read reaches through `clients.transport`; `kind: 'logs'` sends Ethereum's part through its logs order. A graph with states of its own passes their transitions as `ownTransitions`, given the shared read's outcomes, and `start` starts it in another node with its data.

## Minting and pausing on Tempo

The token bridge is built on the queue: a deposit locked in `NoriTokenBridge` on Ethereum, ETH (`lockTokens`) or an ERC-20 (`lockERC20`), is a proof request whose leaf commits to `sha256` of the Tempo recipient's address, and `syncPause` makes an ERC-20's pause state one too. Once the request's snapshot is `proofAvailable`, its witness machine's `verifiedWitness` is its witness in the shape the Tempo bridge takes, and the recipient mints with it: `mintCall` for nETH, `mintERC20Call` for the ERC-20's TIP-20 mirror. Anyone applies a proven pause state to the mirror with `applyPauseCall`. Each is a call, given who signs it, that sends one Tempo transaction; the signer pays the fee in its fee token.

### Sending a transaction through the user's wallet

![Wallet transaction graph](src/rpc/connection/WalletTransactionGraph.svg)

`createWalletTransactionMachine(connections, chain, call)` sends one transaction through the user's wallet on `chain`, then reads its receipt until it is mined:

- `waitingForWallet`: the wallet is not ready to sign (none chosen, on another chain, unreachable); it asks once the wallet is ready.
- `askingToSign`: the wallet shows the transaction. Signed, it moves on to the receipt; the user saying no is `declined`; the wallet or the contract refusing it, or the wallet dropping while asking, is `sendFailed` with the error in `data.error`.
- `declined` and `sendFailed` ask again only on the machine's `send()`: a request the wallet may still hold is never sent twice by itself.
- From `loading` on it is the receipt, read through the chain's connection and again on each new block until mined: `current` holds `data.receipt`, whose `status` is 1 for success and 0 for a revert.

```ts
import { combineLatest, switchMap } from 'rxjs';
import { createWalletTransactionMachine, mintCall } from '@nori-zk/nori-bridge-tempo-sdk';

// proofAvailable$ and verifiedWitness$: the lock's snapshot and witness, from their machines as above.
const minting$ = combineLatest([proofAvailable$, verifiedWitness$]).pipe(
    switchMap(
        ([proofAvailable, witness]) =>
            createWalletTransactionMachine(
                { ethereum, tempo },
                'tempo',
                mintCall(bridgeAddress, witness, proofAvailable.proofQueueBatchIndex)
            ).state$
    )
);
```

A signer of the app's own, such as a private key, sends the call itself, and `createTransactionReceiptMachine(connections, 'tempo', transactionHash)` follows its receipt:

```ts
const receipt$ = mintCall(bridgeAddress, witness, proofQueueBatchIndex)(signer).pipe(
    switchMap((sent) => createTransactionReceiptMachine({ ethereum, tempo }, 'tempo', sent.hash).state$)
);
```

### The token bridge's values

The token bridge's values on Tempo are machines, each read at once and kept current; `current` holds the value:

| Machine | Holds | Reads again on |
| --- | --- | --- |
| `createMintedSoFarMachine(connections, bridgeAddress, recipient, ethToken?)` | `minted`: nETH minted so far, or an ERC-20's mirror's with `ethToken` | `MintApplied` / `ERC20MintApplied` to the recipient |
| `createMirrorMachine(connections, bridgeAddress, ethToken)` | `mirror`: the ERC-20's TIP-20 mirror, `undefined` until registered | `MirrorRegistered` for the ERC-20, until registered |
| `createLastPauseAppliedMachine(connections, bridgeAddress, ethToken)` | `lastPauseApplied`: the batch whose pause state the mirror last followed | `PauseApplied` for the ERC-20 |
| `createTokenBalanceMachine(connections, token, account)` | `balance`: a TIP-20 balance (nETH, a mirror, a fee token) | the token's `Transfer` out of or into the account, a mint included |
| `createFeeTokenMachine(connections, account)` | `feeToken`: the fee token the account chose, `undefined` when none | the fee manager's `UserTokenSet` for the account |

| Calls (Tempo) |
| --- |
| `mintCall(bridgeAddress, depositWitness, proofQueueBatchIndex)` |
| `mintERC20Call(bridgeAddress, depositWitness, proofQueueBatchIndex)` |
| `applyPauseCall(bridgeAddress, pauseWitness, proofQueueBatchIndex)` |

Minting is delta-based: a deposit's leaf carries what was locked so far, and the bridge mints what was not yet minted; minting again with nothing new locked reverts with `ZeroMintAmount`. `applyPause` accepts only a batch newer than the mirror's last pause applied. A transaction that reverts after it was sent is mined with `receipt.status` 0; one the contract refuses beforehand fails to send with the contract's error from ethers' gas estimate (`sendFailed` through the wallet).

## Development

From the repo root:

```sh
npm run reinstall
npm run build
```

`npm run build` builds every workspace: `ethereum/`, `tempo-zk-utils/`, `tempo/` (its Hardhat compile generates the contracts' ethers types this package's `program` entry serves) and `sdk/`.

Tests, from this folder:

```sh
npm run test:unit
npm run test:integration
```

`test:integration` mints and pauses through the sdk on two local nodes it starts itself: an anvil fork of Ethereum mainnet (`ETH_MAINNET_FORK_RPC_URL`, default a public RPC) with the real queue, token bridge and USDC, and `anvil --network tempo` with the real Tempo bridge; each proof queue batch is planted in the bridge's storage as `update` writes it. It needs `anvil` (Foundry) on PATH and network access.

The state machine graphs' images are generated from their definitions with [ystate-visualizer](https://github.com/yaw-rx/ystate), next to each definition. It reads a graph written as `define({ nodes, edges })` or as `define(readThroughConnectionsOf({ … }))`, and `--strict` fails on any graph it cannot draw exactly. From `src/`, for every graph:

```sh
for f in $(grep -rl "= define(" --include=*.ts . | grep -v spec); do
    ystate-visualizer --strict -o "$(dirname "$f")" "$f"
done
```
