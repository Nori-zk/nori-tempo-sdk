# Nori Ethereum→Tempo Bridge — Production Deployment Runbook

End-to-end procedure to deploy the ETH→Tempo bridge: the Ethereum contracts
(`ethereum/`) and the Tempo contracts (`tempo/`). Numbered steps record values
into the deployment ledger (§8).

---

## 0. Inputs and conventions

| Symbol      | Meaning                                          |
| ----------- | ------------------------------------------------ |
| `Operator`  | The Ethereum SAFE multisig                       |
| `Timelock`  | OZ `TimelockController` instance                 |
| `EthBridge` | The deployed `NoriTokenBridge.sol` address       |
| `EthQueue`  | The deployed `NoriProofRequestQueue.sol` address |
| `Bridge`    | The deployed `NoriTempoTokenBridge` address      |
| `Token`     | The bridged nETH TIP-20 address                  |

- All `bytes32` values are 64 hex characters (big-endian); the Tempo deploy
  takes them without the `0x` prefix.
- All Ethereum addresses are 40 hex characters; the Tempo deploy takes them
  without the `0x` prefix.

---

## 1. Set up the Ethereum SAFE

Set up a multisig SAFE on the target Ethereum network (mainnet, Sepolia, …).

### Record

- [ ] `OperatorSafeAddress`: `0x...`

> The SAFE is **not** the bridge operator directly — it becomes the proposer
> and executor of the Timelock in §2. The Timelock is the operator.

---

## 2. Deploy `TimelockController` (Ethereum)

```bash
cd ethereum
cp .env.nori-eth-timelock.example .env   # fill in
npm run deploy-timelock
```

Constructor args (from env):

| Param       | Value                                                       |
| ----------- | ----------------------------------------------------------- |
| `minDelay`  | `NORI_ETH_TIMELOCK_MIN_DELAY_SEC` — recommended `172800` (48 h) |
| `proposers` | `NORI_ETH_TIMELOCK_PROPOSERS` — the SAFE                    |
| `executors` | `NORI_ETH_TIMELOCK_EXECUTORS` — the SAFE (or `0x0…0` for permissionless execution) |
| `admin`     | `NORI_ETH_TIMELOCK_ADMIN` — omit for `address(0)` (self-administered) |

The task writes `.env.nori-eth-timelock` with the deployed address.

### Record

- [ ] `TimelockAddress`: `0x...`
- [ ] `TimelockMinDelay`: e.g. `172800`

---

## 3. Deploy the Ethereum contracts

`npm run deploy` (tasks/deploy.ts) deploys **two** contracts in one run and
wires them together:

1. `NoriProofRequestQueue` — args: `bridgeOperator`, `feeRecipient`, `proofRequestQueueFeeWei`
2. `NoriTokenBridge` — args: `(_bridgeOperator, _proofQueueAddr, _feeRecipient)`

### Required env

```bash
ETH_NETWORK=<network>
ETH_PRIVATE_KEY=<deployer key>
ETH_RPC_URL=<rpc url>

# Operator → the Timelock from §2, not the SAFE
NORI_ETH_BRIDGE_OPERATOR_ADDRESS=<TimelockAddress>

# Fee config (optional)
NORI_ETH_BRIDGE_FEE_RECIPIENT_ADDRESS=<treasury or unset>
NORI_ETH_BRIDGE_LOCK_FEE_RATE=<e.g. 500 = 0.5%>
NORI_ETH_BRIDGE_PROOF_REQUEST_QUEUE_FEE_WEI=<wei, multiple of 1e12>
```

### Run

```bash
cd ethereum
npm run deploy
```

Addresses are written to `.env.nori-eth-token-bridge`.

### Record

- [ ] `EthQueue`: `0x...` (`NORI_ETH_PROOF_QUEUE_ADDRESS`)
- [ ] `EthBridge`: `0x...` (`NORI_ETH_TOKEN_BRIDGE_ADDRESS`)

### Verify

```bash
cast call <EthBridge> "bridgeOperator()(address)"     # == TimelockAddress
cast call <EthBridge> "proofQueue()(address)"         # == EthQueue
cast call <EthBridge> "feeRecipient()(address)"
```

`EthBridge` and `EthQueue` are the `ethTokenBridgeAddressHex` and
`ethProofQueueAddressHex` of the Tempo deploy in §5.

---

## 4. Record the bridge's program vkey and start store hash

### Program vkey

`noriBridgeVk` is fixed by the [nori-bridge-head](https://github.com/Nori-zk/nori-bridge-head)
program build, not chosen at deploy. The deploy reads it from
`@nori-zk/tempo-zk-utils` (`bridgeHeadNoriSP1HeliosProgramVk`, the integrity
file `tempo-zk-utils/src/integrity/nori-sp1-helios-program.vk.json`, a copy of
bridge-head's `nori-elf/nori-sp1-helios-program.vk.json`). Check that the
release in use carries the vkey of the bridge head that will prove.

### Start store hash

The Tempo bridge starts at head 0 and queue cursor 0. Its first `update` is
any proof whose input store hash matches the store hash given at deploy, so
pick the Helios store the bridge head will resume from and take its
`input_store_hash` (64 hex characters, no `0x` prefix).

### Record

- [ ] `noriBridgeVk` (bytes32)
- [ ] `initialStoreHash` (bytes32)

---

## 5. Deploy the Tempo contracts

`npm run deploy` (tempo/tasks/deploy.ts) deploys, in one run:

1. the SP1 v6.1.0 Groth16 verifier (sp1-contracts, pinned in
   `tempo/foundry.lock`), unless `TEMPO_SP1_VERIFIER_ADDRESS` names Succinct's
   (Tempo mainnet: `0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2`);
2. the nETH TIP-20 through Tempo's `TIP20Factory`, with the deployer as its
   admin and pathUSD as its quote token;
3. `NoriTempoTokenBridge` — args: `(verifier, noriBridgeVk, token, initialStoreHash, EthBridge, EthQueue)`;
4. `ISSUER_ROLE` on the token for the bridge, so only the bridge mints.

### Required env

```bash
TEMPO_NETWORK=<moderato | mainnet>
TEMPO_RPC_NETWORK_URL=<rpc url>
TEMPO_PRIVATE_KEY=<deployer key, holding a fee token such as pathUSD>
TEMPO_SP1_VERIFIER_ADDRESS=<Succinct's verifier, or empty to deploy one>
```

### Run

```bash
cd tempo
npm run deploy -- <initialStoreHash> <EthBridge> <EthQueue>
```

`nori-cli` deploys the same contracts from Rust, reading the same env:

```bash
cargo run -p nori-cli -- deploy <initialStoreHash> <EthBridge> <EthQueue> \
    --dry-run   # remove to send; asks for confirmation unless --yes
```

Addresses are written to `tempo/.env.nori-tempo-token-bridge` (`nori-cli`
prints the same lines).

### Record

- [ ] `Bridge`: `0x...` (`NORI_TEMPO_TOKEN_BRIDGE_ADDRESS`)
- [ ] `Token`: `0x...` (`NORI_TEMPO_TOKEN_ADDRESS`)
- [ ] Bridge deploy block (`NORI_TEMPO_TOKEN_BRIDGE_DEPLOY_BLOCK`)
- [ ] Verifier (`TEMPO_SP1_VERIFIER_ADDRESS`)

### Verify

```bash
cast call <Bridge> "noriBridgeVk()(bytes32)"                 # == noriBridgeVk
cast call <Bridge> "latestHeliosStoreInputHash()(bytes32)"   # == initialStoreHash
cast call <Bridge> "ethTokenBridgeAddress()(address)"        # == EthBridge
cast call <Bridge> "ethProofQueueAddress()(address)"         # == EthQueue
cast call <Token> "hasRole(address,bytes32)(bool)" <Bridge> $(cast keccak ISSUER_ROLE)   # == true
```

### Register the ERC-20 mirrors

Each ERC-20 that users lock with `NoriTokenBridge.lockERC20` is minted on
Tempo as its own TIP-20 mirror, and `mintERC20` reverts with `NoMirror` until
that mirror exists. Only the bridge's deployer (`mirrorAdmin`, fixed at
deploy) can create one, so run this once per ERC-20 with the deployer's env
from above and `NORI_TEMPO_TOKEN_BRIDGE_ADDRESS` set:

```bash
cd tempo
npm run register-mirror -- <ethToken> <name> <symbol> <currency>
```

The bridge creates the TIP-20 through `TIP20Factory`, with itself as admin
and pathUSD as quote token, and grants itself `ISSUER_ROLE`, `PAUSE_ROLE` and
`UNPAUSE_ROLE`, so only proven deposits mint it and only proven pause states
pause it. The currency is fixed at creation: `USD` makes the mirror a Tempo
fee token, any other ISO 4217 code does not. A second registration for the
same ERC-20 reverts with `MirrorExists`.

*Output on a local `anvil --network tempo`, for mainnet USDC:*

```
[RegisterMirror] Mirror of 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48: 0x20C0000000000000000000003E14745cBAe3d986 (nUSDC), block 1161
```

### Record

- [ ] Per ERC-20: its Ethereum address, its mirror's address, the mirror's currency

### Verify

```bash
cast call <Bridge> "mirrorAdmin()(address)"                     # == the deployer
cast call <Bridge> "mirrorOf(address)(address)" <ethToken>      # == the mirror
cast call <Mirror> "currency()(string)"                         # == <currency>
cast call <Mirror> "hasRole(address,bytes32)(bool)" <Bridge> $(cast keccak ISSUER_ROLE)    # == true
cast call <Mirror> "hasRole(address,bytes32)(bool)" <Bridge> $(cast keccak PAUSE_ROLE)     # == true
cast call <Mirror> "hasRole(address,bytes32)(bool)" <Bridge> $(cast keccak UNPAUSE_ROLE)   # == true
```

---

## 6. Run the proof submitter

`update` is permissionless: the only credential is a valid proof. The
processor (nori-tempo-processor-rabbit) sends each bridge head proof with
`TEMPO_PRIVATE_KEY`, pointed at `NORI_TEMPO_TOKEN_BRIDGE_ADDRESS`.

Every `update` whose batch drains at least one proof request writes one
proof queue batch (two new storage slots, 250,000 gas each on Tempo) on top
of the transaction; updates with empty batches only advance the head. Keep
the sender funded with its fee token (pathUSD).

### Record

- [ ] Submitter address and its funding source

### Keep each mirror's pause in step with its ERC-20

A mirror is paused and unpaused only by proof of its ERC-20's `paused()` on
Ethereum, in two permissionless calls:

1. On Ethereum, `NoriTokenBridge.syncPause(token)` copies `paused()` into the
   bridge and requests a proof of it. The caller pays the queue fee in ETH,
   exactly (`proofRequestQueueFee()`). Tokens without `paused()` revert with
   `TokenNotPausable`.
2. Once a batch covering that request is committed on Tempo,
   `NoriTempoTokenBridge.applyPause(witness, proofQueueBatchIndex)` pauses or
   unpauses the mirror. The caller pays the Tempo fee in its fee token. Only
   a batch newer than the last one applied for that token is accepted
   (`PauseNotNewer`).

Run `syncPause` after every `Paused` or `Unpaused` event of a mirrored
ERC-20:

```bash
cd ethereum
npm run sync-pause -- <ethToken>
```

*Output on a local mainnet fork, for USDC:*

```
[SyncPause] Synced 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48: paused false, block 26156441, tx 0x8c3a704d3709ccb7981d40ad85794b7a7553b067e1f54f9a296c34136239e585
```

The pause reaches Tempo after Ethereum finality and one bridge head proof.
The keeper in nori-worldsfair-submission-tempo (`client/`, `sync-pauses` and
`apply-pauses`) runs both calls for every ERC-20 in its config.

### Record

- [ ] Who runs `syncPause` and `applyPause`, and their ETH and fee token funding

---

## 7. Post-deploy hardening

1. **Timelock admin**: confirm
   `TimelockController.hasRole(DEFAULT_ADMIN_ROLE, <SAFE>)` is `false` and the
   contract is self-administered (automatic if `admin = address(0)` in §2).
2. **Dry-run the SAFE → Timelock → bridge path**: schedule a no-op admin call
   (e.g. set the lock fee rate to its current value) through the Timelock
   before any value flows.
3. **Token admin**: the deployer is the TIP-20's admin; move that role to a
   controlled key or the SAFE's Tempo counterpart.
4. **First proof end-to-end**: submit one `update` carrying a real
   nori-bridge-head proof, then one `mint` against a real deposit, on Moderato
   before mainnet.
5. **Archive env outputs**: `.env.nori-eth-token-bridge`,
   `.env.nori-eth-timelock`, `.env.nori-tempo-token-bridge`, and the §4
   values go in the deployment ledger (no secrets).

---

## 8. Final ledger (fill in)

| Field                          | Value |
| ------------------------------ | ----- |
| Network (Ethereum)             |       |
| Network (Tempo)                |       |
| Deploy date (UTC)              |       |
| `OperatorSafeAddress`          |       |
| `TimelockAddress`              |       |
| Timelock `minDelay`            |       |
| `EthQueue`                     |       |
| `EthBridge`                    |       |
| Initial `feeRecipient`         |       |
| Initial `lockFeeRate`          |       |
| `noriBridgeVk`                 |       |
| `initialStoreHash`             |       |
| `Bridge`                       |       |
| `Token`                        |       |
| Verifier                       |       |
| Bridge deploy block            |       |
| `mirrorAdmin` (deployer)       |       |
| ERC-20 mirrors (ERC-20, mirror, currency) |  |
| `syncPause` / `applyPause` runner |    |
| Ethereum deploy tx hashes      |       |
| Tempo deploy tx hashes         |       |

---

## Appendix A — Constructor signatures

```solidity
// ethereum/contracts/NoriTokenBridge.sol
constructor(
    address _bridgeOperator,   // = TimelockAddress (NOT the SAFE directly)
    address _proofQueueAddr,   // = EthQueue (§3)
    address _feeRecipient      // = treasury or address(0) to defer
)

// ethereum/contracts/NoriProofRequestQueue.sol
constructor(
    address _bridgeOperator,   // = TimelockAddress
    address _feeRecipient,     // = treasury or address(0)
    uint256 _proofRequestQueueFeeWei
)

// tempo/contracts/NoriTempoTokenBridge.sol
constructor(
    ISP1Verifier verifier_,                // = the SP1 v6.1.0 Groth16 verifier
    bytes32 noriBridgeVk_,                 // = noriBridgeVk (§4)
    ITIP20 token_,                         // = Token
    bytes32 latestHeliosStoreInputHash_,   // = initialStoreHash (§4)
    address ethTokenBridgeAddress_,        // = EthBridge (§3)
    address ethProofQueueAddress_          // = EthQueue (§3)
)
// mirrorAdmin = msg.sender, the deployer: the only caller of registerMirror (§5)
```

## Appendix B — Open tooling gaps

- [ ] Dry-run script proposing a no-op admin call through the Timelock (§7.2).
