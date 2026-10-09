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
