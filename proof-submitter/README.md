# proof-submitter

Client crate for the Nori Ethereum→Tempo bridge. It loads SP1 Groth16
proof JSONs — as produced by
[nori-bridge-head](https://github.com/Nori-zk/nori-bridge-head) — into the
arguments of `NoriTempoTokenBridge.update`, deploys the bridge, and submits
`update` transactions over JSON-RPC.

Library only: `update` submission is driven from the processor
(nori-tempo-processor-rabbit). The deploy is also run with `nori-cli`
(`cli/`, DEPLOYMENT.md §5), built on this crate.

## Bindings

[bridge.rs](src/bridge.rs) generates alloy bindings (`sol!`) from the
Tempo contracts' Hardhat artifacts in `../tempo/artifacts/`:
`NoriTempoTokenBridge`, the sp1-contracts v6.1.0 Groth16 `SP1Verifier`,
`ITIP20` and `ITIP20Factory`, plus the `TIP20_FACTORY_ADDRESS` and
`PATH_USD_ADDRESS` precompiles. Build `tempo/` (`npm run build -w tempo`)
before this crate.

## Loading proofs

`load_update_proof(path)` loads one JSON; `load_update_proofs_dir(dir)`
loads every `*.json` in a directory, ordered by file name (the
`<slot>-v<x.y.z>.json` naming sorts into chain-continuation order). Both
return `LoadedProof { wire: UpdateProof, program_vkey: [u8; 32] }`, and
`LoadedProof::outputs()` decodes its public values.

`update`'s arguments, from the proof JSON fields:

- `wire.proof` — 356 bytes: the first 4 bytes of `groth16_vkey_hash` (the
  verifier selector) ++ the 352-byte `encoded_proof`
  (`[exit_code 32][vk_root 32][nonce 32][groth16 256]`).
- `wire.sp1_public_inputs` — `public_values.buffer.data`, the 220-byte
  `ProofOutputs` (fixed big-endian offsets).
- `program_vkey` — `public_inputs[0]` (decimal), the SP1 program vkey; must
  equal the `noriBridgeVk` the bridge pins at deploy (`nori-elf`'s
  `NORI_SP1_HELIOS_PROGRAM_VK`).

## Deploying and submitting

`TempoProofSubmitter`:

- `from_env()` — config from environment (see below); `.env` files are
  picked up via dotenvy.
- `new(rpc_url, signer, bridge_address)` — explicit construction.
- `deploy_contract(store_hash, eth_token_bridge_address,
  eth_proof_queue_address, nori_bridge_vk, verifier).await` — deploys the
  sp1-contracts v6.1.0 Groth16 verifier unless `verifier` is given, creates
  the nETH TIP-20 through `TIP20Factory` (the sender as admin, pathUSD as
  quote token), deploys the bridge and grants it `ISSUER_ROLE`; returns
  `DeployedTempoBridge { verifier, token, bridge, bridge_deploy_block }` and
  points the submitter at the new bridge. The bridge starts at head 0 and
  cursor 0; its first `update` is any proof whose input store hash is
  `store_hash`. Each step is also its own function: `deploy_verifier`,
  `create_token`, `deploy_bridge`, `grant_issuer_role`.
- `fetch_state().await` — the bridge's `state()`.
- `submit_update(&proof.wire).await` — sends `update` and waits for its
  receipt, which on Tempo is final; returns
  `TempoTransactionResult { tx_hash, gas_used }`. A revert carrying one of
  the bridge's errors comes back as `SubmitterError::BridgeRevert`. If
  another update lands first, the contract's checks reject this one.

### Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `TEMPO_RPC_NETWORK_URL` | yes | Tempo JSON-RPC endpoint |
| `TEMPO_PRIVATE_KEY` | yes | Hex private key of the sender, which pays fees in its fee token (pathUSD) |
| `NORI_TEMPO_TOKEN_BRIDGE_ADDRESS` | yes | The deployed `NoriTempoTokenBridge` |

## Tests

From the repo root, with `anvil` (Foundry) on PATH and the Tempo contracts
built:

```bash
npm run build -w tempo
cargo test -p proof-submitter
```

Two suites:

- `tests/proof_file.rs` — host tests for the JSON loader, the example
  series' chaining, its zero queue cursors and its program vkey.
- `tests/update_anvil.rs` — end-to-end against a local Tempo node. Each test
  boots its own `anvil --network tempo` through `test-utils` (a free port,
  killed on drop), deploys the bridge with `deploy_contract` from the first
  example proof's input store hash and queue address, and submits updates
  through `TempoProofSubmitter` over RPC.

Run the host tests only with
`cargo test -p proof-submitter --test proof_file`.

The example proofs live in `proof-submitter/example-proofs/`: the
integration test data, four chained `update` proofs with empty batches (no
deposits), so they commit no proof queue batches and do not exercise
`mint`. `mint` is covered by the contracts' Hardhat suite
(`tempo/test/NoriTempoTokenBridge.ts`), which plants batches with
`anvil_setStorageAt`.

## Manual smoke test on a local Tempo node

```bash
# 1. Start a local Tempo node (RPC and websocket on 8545).
anvil --network tempo

# 2. Point the submitter and nori-cli at it (separate shell), with dev account 0.
export TEMPO_RPC_NETWORK_URL=http://127.0.0.1:8545
export TEMPO_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

Then deploy the bridge with the first proof's input store hash and queue
address — from the repo root, `cargo run -p nori-cli -- deploy
<storeHash> <ethTokenBridgeAddress> <ethProofQueueAddress>` (it reads the
two variables above), or in Rust `deploy_contract` — and call
`submit_update` per proof; see `tests/update_anvil.rs` for the full
sequence.
