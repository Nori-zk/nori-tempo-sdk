# AGENTS.md — working notes for AI agents

## What this repo is

SDK + on-chain code for the Nori Ethereum→Tempo token bridge:

- Users lock ETH and ERC-20s in `NoriTokenBridge.sol`; each lock, and each
  `syncPause` of an ERC-20's pause state, enqueues a storage-proof request on
  `NoriProofRequestQueue.sol`.
- [nori-bridge-head](https://github.com/Nori-zk/nori-bridge-head) (Helios
  light client + SP1) proves Ethereum consensus/execution state and folds
  pending deposits into a Merkle root.
- The Tempo contract (`tempo/contracts/NoriTempoTokenBridge.sol`) verifies
  SP1 Groth16 proofs with sp1-contracts' v6.1.0 verifier and mints a TIP-20
  against proven deposits: nETH for ETH, and one TIP-20 mirror per ERC-20,
  paused and unpaused with its ERC-20.

The `ethereum/` contracts take the Nori bridge's Ethereum-side design as a
baseline, scoped down for this route: one-way, lock only, no unlock path.

## Layout

| Path | Contents |
| --- | --- |
| `ethereum/contracts/` | `NoriTokenBridge.sol`, `NoriProofRequestQueue.sol`, `TimeLockController.sol` (vanilla OZ, for deploys) |
| `ethereum/tasks/` | Hardhat tasks: deploy, deployTimelock, lockTokens, lockERC20, syncPause, fee admin (incl. withdrawTokenFees), previews, fundFromHolder (local forks) |
| `ethereum/test/` | Mocha tests (run via Hardhat); `test-vectors/` holds storage-layout vectors shared with the SP1 guest |
| `ethereum/test-fork/` | ERC-20 tests on real mainnet USDC/WETH on the `mainnetFork` network (`npm run test:fork`); out of `test/` because they need a mainnet RPC |
| `ethereum/scripts/` | `erc20-fork-check.sh` (`npm run test:erc20-fork-flow`): every ERC-20 task through its npm script on a local fork |
| `ethereum/types/ethers-contracts/`, `tempo/types/ethers-contracts/` | **Generated** by `hardhat compile`; committed after `stabilize-types.mjs` sorts unstable lines. Never hand-edit |
| `tempo/contracts/` | `NoriTempoTokenBridge.sol`, `interfaces/ITIP20.sol`, `interfaces/ITIP20Factory.sol` |
| `tempo/lib/` | **Gitignored**: sp1-contracts cloned by `npm run lib` at the tag in `tempo/foundry.lock`; Hardhat compiles its `v6.1.0` verifier |
| `tempo/tasks/deploy.ts` | Deploy: verifier (unless given), nETH TIP-20 via `TIP20Factory`, bridge, `ISSUER_ROLE` |
| `tempo/tasks/registerMirror.ts` | `npm run register-mirror`: the deployer creates an ERC-20's TIP-20 mirror (DEPLOYMENT.md §5) |
| `tempo/test/` | Hardhat suite on `anvil --network tempo`; integration test data in `test_examples/`, `proofs/`, indexed by `constructExampleProofs.ts`; vendored `test-vectors/` |
| `tempo-zk-utils/` | Integrity program vkey, proof decoding, first example proof, vendored vectors |
| `proof-submitter/` | Rust client crate: alloy bindings from the Tempo artifacts, proof-JSON loader, `TempoProofSubmitter` (deploy + `update` sender) |
| `cli/` | `nori-cli` operator binary on top of `proof-submitter`: `deploy` (DEPLOYMENT.md §5) |
| `sdk/src/program/` | Re-exports `@nori-zk/tempo-token-bridge` (the contracts' ethers types) as the sdk's `./program` entry |
| `nori-hash-utils/` | Workspace crate compiling nori-bridge-head's `nori-hash` (without its default `helios` feature) to WebAssembly with `wasm-bindgen` + `tsify`; `pkg/` is build output |
| `test-utils/` | anvil harness (node with kill-on-drop on a free port, dev signers, `set_storage_at`/`time_travel` cheatcodes); no dependency on the contracts, so apps built on the bridge can use it |
| `proof-submitter/example-proofs/` | Integration test data: four chained SP1 Groth16 proofs (no deposits) used by the Rust suites |
| `DEPLOYMENT.md` | Production runbook (Safe → Timelock → ETH contracts → Tempo contracts) |
| `DEVELOPMENT_GUIDE.md` | Toolchain setup (Rust, Node, Foundry), the local Tempo node, contracts build and test |

## Commands that work today

```bash
npm ci
npm run build -w tempo-zk-utils
npm run build -w tempo        # npm run lib + compile + stabilize-types + tsc
npm run build -w sdk
npm run test -w tempo-zk-utils
anvil --network tempo &       # then:
npm run test -w tempo         # 44 passing
npm run test -w ethereum      # 126 passing
npm run test:fork -w ethereum # 8 passing: ERC-20 locking and pause sync on real mainnet USDC/WETH (local fork, needs network)
npm run test:erc20-fork-flow -w ethereum  # every ERC-20 task through its npm script on a local fork: "All steps passed"
npm run test:unit -w sdk
npm run test:integration -w sdk  # mint, mintERC20 and applyPause through the sdk on its own anvil mainnet fork + anvil --network tempo (needs network)
npm run lint -w sdk

cargo test                    # Rust suites (needs anvil on PATH and tempo/ artifacts)
cargo run -p nori-cli -- deploy --help
```

## Build quirks

- `proof-submitter` generates its alloy bindings from `tempo/artifacts/`:
  build `tempo/` before `cargo build`.
- sp1-contracts tag `v6.1.0` ships a broken Groth16 verifier; `foundry.lock`
  pins tag `v6.1.1`, whose `contracts/src/v6.1.0` is the correct one.
- Hardhat emits artifacts only for files under `paths.sources.solidity`, so
  `hardhat.config.ts` adds `./lib/sp1-contracts/contracts/src/v6.1.0`. Its
  Plonk verifier is also named `SP1Verifier`: always use the fully
  qualified `lib/sp1-contracts/contracts/src/v6.1.0/SP1VerifierGroth16.sol:SP1Verifier`.
- TIP-20 `hasRole` takes the account first: `hasRole(address,bytes32)`.

## Invariants that bite if broken

- `lockedTokens` must stay at storage slot 2 of `NoriTokenBridge.sol`
  (`LOCKED_TOKENS_SLOT_INDEX`, and the "Should keep lockedTokens at slot 2"
  test). Reordering state vars above it invalidates every enqueued proof
  request and the SP1 circuit.
- The storage-slot indices in `test/NoriProofRequestQueue.ts` are mirrored in
  the SP1 guest (`nori-primitives` in nori-bridge-head). Changing them
  invalidates previously generated proofs.
- 1 bridge unit = 10¹² wei on the Ethereum side (`DECIMALS = 6`), the same
  as a TIP-20's 6 decimals. `MAX_MAGNITUDE = 2⁶⁴−1` BU keeps the Tempo-side
  `uint64` mint amounts sound — do not raise `DECIMALS` or drop the cap.
- The bridge pins `proofQueue` as an immutable with no setter; the Tempo
  bridge pins the same two addresses as immutables at deploy. Both sides move
  together or not at all.
- `NoriTempoTokenBridge`'s storage layout (documented in its State section)
  is what the tests plant batches into with `anvil_setStorageAt`; reordering
  its state variables changes it.
- Proof queue batches are append-only, created only by `update` and only for
  non-empty batches, with contiguous indices from 0 (`proofQueueBatchCount`).
  `findProofQueueBatch`'s binary search relies on their cursor ranges
  increasing.
- ERC-20 storage in `NoriTokenBridge.sol` is appended after the fee state:
  slot 6 `lockedERC20`, 7 `totalLockedERC20BU`, 8 `pauseState`, 9
  `accumulatedTokenFees` (`LOCKED_ERC20_SLOT_INDEX`, `PAUSE_STATE_SLOT_INDEX`,
  pinned by the fork tests). New state goes after them, never above.
- `NoriTempoTokenBridge` appends slot 5 `mirrorOf`, 6 `erc20MintedSoFar`, 7
  `_pauseAppliedPlusOne` after `mintedSoFar`; the planted-batch layout above
  them is unchanged.
- Leaves are told apart by their collection keys, never by their slot: an ETH
  deposit has one key, an ERC-20 deposit `[codeChallenge, token]`, a pause
  state `[PAUSE_KEY, token]` with value 1 or 2. `lockERC20` refuses
  `PAUSE_KEY` as a codeChallenge and `mint` requires one key; keep both, or a
  deposit could pass for a pause or mint the wrong token.
- `applyPause` accepts only a batch newer than the last one applied for the
  token: a batch's proof read the pause state at its own Ethereum block.
- The mirror admin (`registerMirror`) is the Tempo bridge's deployer, an
  immutable; mirrors are created with the bridge as their admin.
- `PAUSE_KEY` is `keccak256("NORI_PAUSE_STATE")` on both chains and in both
  `const.ts` files (computed with `id`, never pasted); the tests compare them
  with the contracts.

## Integration test data

- The example proofs (`proof-submitter/example-proofs/`,
  `tempo/test/test_examples/<input slot>/sp1Proof.json`,
  `tempo/test/proofs/sp1Proof.json`, and the first one in
  `tempo-zk-utils/src/test-examples/sp1-mpt-proof/`) are integration test
  data: CI runs the bridge head for four cycles against an Ethereum
  `NoriProofRequestQueue` that accepts no locks or proof requests. Every
  example proof therefore drains no requests: its input and output queue
  cursors are 0, by definition. Tests that need requests or committed
  batches plant them on top (`anvil_setStorageAt`), never in the proofs.
- The bridge starts at head 0 and cursor 0. Tests and test-mode deploys
  take the start store hash and the queue address by decoding the first
  example proof (`decodeConsensusMptProof`,
  `extractEthProofQueueAddressFromSP1Proof` from `@nori-zk/tempo-zk-utils`;
  `LoadedProof::outputs()` in Rust).
- `tempo/test/constructExampleProofs.ts` indexes the example proofs
  (`buildExampleProofCreateArgument`, `buildExampleProofSeriesCreateArguments`);
  keep it, the `test_examples/` folders and `proofs/` in this layout, since
  CI rewrites them.

## Conventions

- Docs and comments must not reference the chain this SDK was forked from;
  describe the ETH→Tempo design as it stands.
- Run the `ethereum/` and `tempo/` suites after any contract change;
  regenerate types via `npm run build` and commit the stabilized output.
- `.env.nori-eth-token-bridge` / `.env.nori-eth-timelock` /
  `.env.nori-tempo-token-bridge` are gitignored deploy outputs; the
  `.example` files are the committed templates.
- Keep README.md, DEPLOYMENT.md, and this file in sync with code changes.
- Changing and releasing the sdk (`@nori-zk/nori-bridge-tempo-sdk`), in this order:
    1. Collect everything the apps need from it first, so one release covers it.
    2. Explain each change and why, and ask. Change nothing until the user says yes.
    3. Make the changes, bump the version (`package.json`, `sdk/package.json`, `package-lock.json`), and run its build, lint and unit tests.
    4. `git add` the changed paths and give the user the commit message. The user commits and pushes.
    5. Run `npm run publish -- --dry-run` (`nw-publish`) and report it. The user publishes.

## Lessons

jk89 was sad the agents ignored his abstraction and worked around it

- ystate and yaw are not in the training data. Without them, agents reach
  for what they know: promises, `async`/`await`, `firstValueFrom`, helper
  functions, one-shot reads, loading flags and `catchError` fallbacks. Before
  writing anything, read the ystate README, `rpc/connection/readThroughConnections.ts`
  with its `.impl.ts`, and one machine built on it
  (`proofQueue/bridgeState.ts` with its `.impl.ts`); then build the value as
  a machine the same way.
- The public API is the funnel: it exports machines, live streams, and the
  shared shape an app builds its own read machine from
  (`readThroughConnectionsOf`, `startReadThroughConnectionsMachine`, whose
  read is given the clients). Never export a runner (`forCalls$`,
  `forLogs$`), a one-shot read, a readiness gate or a transport's
  provider: every public piece a machine is built from becomes a way
  around the machine.
- Every value read through the connections is a machine: a two-line graph
  `define(readThroughConnectionsOf({ value }))` and a `createXMachine` that
  passes `startReadThroughConnectionsMachine` only what is its own: the
  read, the chains it needs and its refresh trigger (`bridgeState`,
  `mirror`, `proofRequestWitness`). The factory holds everything every
  machine repeats. A value read once (a witness) is still a machine whose
  refresh never comes. Pure functions stay functions; a send stays an
  action.
- A `createXMachine` returns the running machine itself, with its controls
  on it (`retry()`, `close()`, `loadMore()`): never a wrapper whose
  `.machine` the caller has to reach into.
- A read tries once. Retrying belongs to the machine (`failedWhile…`,
  `retryDue`, `retry()`); a retry loop inside a read hides the failure, keeps
  the machine in `loading` and tells the transport late.
- A transaction is a machine too: its own states in front (waiting for the
  wallet, asking to sign, declined, failed), spreading
  `readThroughConnectionsOf` for the receipt after it. Never wait for a
  receipt inside a promise (`sent.wait()`); the receipt machine owns it. A
  contract call is one `…Call` both paths use, never a send per signer.
- Tests read a machine as a stream that ends: `waitForNode`, `nodesUntil`,
  `statesDuring`, or a `valueOnceRead$` helper typed by the graph. Never subscribe
  into an array a test inspects later, never `sleep` and check, never a
  promise helper with `try/finally` around a machine. "Nothing happens" is
  asserted as the states it stays in (`statesDuring`).
- An event the sdk subscribes to is confirmed against what the chain
  actually emits (a real local node), and its topic is computed in
  TypeScript from its signature (`id('Transfer(address,address,uint256)')`),
  never added to a contract interface for the sdk's sake.
- Removing a public read removes a capability. Build its machine first,
  prove it with the tests, then take the read out of the public API, never
  the other way round.
- Machines are isolated by domain: each holds only its own domain's
  states. One machine uses another by gating its own transitions on the
  other's `state$`, as the ystate README shows: the heater's transitions
  gate on `temperature$` (the physics example, "Coupled systems"), and
  Payment's `pay` gates on `deps.auth.state$` (the auth example, README
  "Quick look" and the studio's checkout workspace). A graph can also
  spread another graph's nodes and edges into its own
  (`...readThroughConnectionsOf(...)`). Never copy another machine's
  states into your own data.
- A machine describes one domain; everything else is the outside world,
  which it reaches only through `$`. Fixed configuration is not input: an
  address or an RPC URL known when the machine is made defines the
  machine. What arrives or changes during its life (data, another
  machine's state, the user, the chain) comes in through `$`, and the
  graph shows three things for it: the input arriving through `$`, an
  edge that fires only when the outside allows it (the gate), and the node
  the machine waits in until it does. That node is usually the one the
  gated edge leaves from: the heater waits in `idle` until
  `belowLowerLimit` lets it through, and Payment waits in `checkout` until
  `payRequest` brings the card. A node of its own is needed only when why
  it waits is something the domain shows or handles: Payment's
  `notLoggedIn`, which the user sees and `dismiss` leaves, or
  `waitingForConnectionWhile…`, which names the chain it waits on. A gate
  either waits or refuses: a filter in `$` waits silently (the heater's
  thresholds), an error edge refuses explicitly (`pay` errors into
  `notLoggedIn`); it refuses when the outside saying no is a state of the
  domain. Without these, the dependency is handled in code around the
  graph, and the graph no longer describes what the machine does.
- A transition's `$` is the external environment: "an Observable factory
  over the external environment", whose "emissions are outside the
  machine's control" (`clean/yaw/ystate/packages/ystate/README.md`, "Core
  concepts", the Σ row of "The formalism" and "Transitions";
  `TransitionShape.$` in `clean/yaw/ystate/packages/ystate/src/transitions.ts`).
  Everything outside the graph enters a machine only there: another
  system (the chain, Nori's server, the browser), another machine
  (`deps.auth.state$`), and the inputs of a call. So:
  - External state belongs in the streams that feed `$`; the graph holds
    only what the machine itself decides.
  - A machine exists before its work arrives, and the work's inputs arrive
    through an edge's `$`. Payment sits in `checkout` from the start; `pay`
    fires when `payRequest` emits, and `payRequest` carries the card, so
    nothing is created late to hold the card
    (`clean/yaw/ystate/packages/example/src/payment.ts`, or the studio's
    checkout workspace in
    `clean/yaw/ystate/packages/studio/src/app-root/default-workspaces.ts`).
    A machine created per call with its inputs baked into its factory is
    the opposite of this.
  - Gating on another machine is also `$`: `pay` reads `deps.auth.state$`
    with `withLatestFrom`; when Auth is not `authenticated` its error edge
    goes to `notLoggedIn`, and `dismiss` brings it back to `checkout`. No
    helper and no spawned machine.
- A machine is started by its owner, who closes it; ownership never
  transfers (the README: `Basket.close().start('empty', { auth })`, and
  stopping basket leaves auth running). A machine that needs data known
  only at runtime is started by whoever has that data (the app, or a
  `create…Machine`), never inside another machine's streams: no starting a
  machine in a `$`, a `refreshOn` or a `defer`, and no helper that does it
  for you. ystate has no `spawn()` on purpose. A reading machine's creator
  starts the chain changes machine it gates on and passes it in `owns`.
- The graph holds the machine's own domain state; the outside world is
  observed in the shape it has, like `temperature$` in the heater example.
  Holding the outside world outside the graph is the idiom, not a break of
  it, when the state classifies an external system's behaviour. ystate's
  README shows both kinds of external system: the heater classifies the
  room by observing `temperature$` (the physics example), and Basket
  classifies auth by gating `checkout` on `deps.auth.state$` being
  `authenticated` (the auth example); neither holds the other's states in
  its graph. Read them before judging any state:
  - the heater and the room: `clean/yaw/ystate/packages/ystate/README.md`,
    section "Coupled systems" ("A heater FSM", then "A Physics
    simulation"); runnable in `clean/yaw/ystate/packages/example/src/heater.ts`.
  - Basket and auth: the same README, section "Quick look" (the Basket
    graph and its `checkout` transition), and "Machine sets with multiple
    machines" (Auth started by its owner and passed into
    `Basket.close().start('empty', { auth })`); runnable in
    `clean/yaw/ystate/packages/example/src/basket.ts`, `auth.ts` and
    `payment.ts`; the studio's checkout workspace in
    `clean/yaw/ystate/packages/studio/src/app-root/default-workspaces.ts`
    (search `checkout`).
  So in this sdk:
  - `sinceRead$` classifies the chain, as the heater classifies the room:
    whether it moved on since a read began.
  - the unprocessed machine's `scope.applied` classifies Nori's server, as
    Basket classifies auth: which update its pipeline has applied.
  - the wallet machine's `wallets` map classifies the browser: which
    wallets have announced themselves (EIP-6963).
  Keeping such an observation subscribed while the machine moves between
  nodes (`heldAcrossMoves`) is part of observing it, not state. A `$`
  reading the entered node's data (`dataOnEntry$`) reads the graph's own
  state, which is in the graph. Before calling something "state outside the
  graph", ask what it classifies: our domain belongs in the graph, an
  external system's behaviour does not.
- ystate's source is in `clean/yaw/ystate/packages/ystate/src`. Before
  writing any type or helper about a graph, look there first: a transition's
  name is `TransitionNames`, a transition `TransitionDef`, a node's data
  `ResolveNodeData`, a state `StateUnion`, a running machine
  `RunningMachine` / `RunningMachineSet`, a defined graph
  `IncidenceGraphSetMixin`. Writing your own copy of one is the same mistake
  as a hand-written union beside the graph.
- A shape several graphs share is written once and spread:
  `readThroughConnectionsOf(data)` (a value read and kept current),
  `healthCheckedOf(carried)` (a connection checked by its health; http and
  the wallet). Their transitions are written once too
  (`readThroughConnectionsTransitions`, `healthCheckedTransitions`), and so
  is a pattern the machines repeat: one request per entry into a node,
  shared by its outcome edges, is `requestOnEntry$`; outcomes split by a
  field are `withOutcome`.
- `refreshOn` is followed from before each read: its first emission says it
  is following, each later one that a refresh is due. A chain trigger is
  `changesOf$` of an owned chain changes machine, following once its
  starting block is known (first poll, or the node acknowledging
  `eth_subscribe`); anything without a starting point goes through `dueOn`. Starting a trigger only once the value is held
  misses what changes during the read.
- A read from a chain is an observable named for what it gives
  (`bridgeState$`, `proofQueueBatches$`), built on `evmRpcRead$` (the one
  ethers call, its failure an `EvmRpcTransportError`); loops over block
  ranges are `from(blockRanges(…)).pipe(concatMap(…))`. A read that awaits
  another read is logic in promises.
- Stop using promises: this is an rxjs library. Every function, lambda,
  runner and API the sdk exposes takes and returns observables or machines.
  A promise exists only inside the lowest step, where a dependency (ethers)
  returns one, wrapped once with `defer`; nothing above it sees a promise.

- The connection layer (`createConnections`, each transport's machine,
  `readThroughConnections$`, the readiness streams) and the machines exist
  so that nothing else handles connectivity. Use them; never work around
  them. Before writing code, find how the abstraction already does it.
- Machines are for abstraction. Every read through the connections is one
  machine driven by a lambda (the read, the chains it needs, when to read
  again); domain state lives in the value the lambda returns. Code is never
  copied: the second time the same code appears, it is abstracted into one
  place every user calls. That covers a machine's waiting, failed and retry
  edges, and the setup every `createXMachine` repeats (its subjects,
  `stateOf$`, `implement`, `start`, `retry()` and `close()`).
- Nothing is read once. A value that can change is kept current on its
  trigger (new heads, logs, a recheck signal). A one-shot read (`fetch…`,
  `…From`, a promise) is only ever the step a machine runs; no stream
  swallows a failure with `catchError(() => EMPTY)`: a failure is a state.
- Finding a shortcut means searching the whole codebase for the same
  pattern and fixing every instance.
