//! End-to-end deploy and `update` tests against a local Tempo node
//! (`anvil --network tempo`), driving the real RPC path: verifier, token and
//! bridge deploy → `TempoProofSubmitter::submit_update` over JSON-RPC.
//!
//! Every test boots its own node on a free port, deploys through the
//! submitter crate with the first example proof's input store hash and queue
//! address, and tears the node down on drop. Requires `anvil` on PATH and the
//! contracts' artifacts (`npm run build -w tempo`, see DEVELOPMENT_GUIDE.md).

use {
    alloy::primitives::{Address, B256},
    nori_sp1_helios_primitives::types::ProofOutputs,
    proof_submitter::{
        bridge::NoriTempoTokenBridge::{BridgeState, NoriTempoTokenBridgeErrors},
        load_update_proofs_dir, DeployedTempoBridge, LoadedProof, SubmitterError,
        TempoProofSubmitter, TempoTransactionResult,
    },
    test_utils::{dev_signer, Anvil},
};

const PROOFS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/example-proofs");
const SLOT_1: u64 = 11_298_144;
const SLOT_2: u64 = 11_298_176;
const SLOT_3: u64 = 11_298_208;
const SLOT_4: u64 = 11_298_240;
const BLOCK_1: u64 = 11_857_617;
/// The Ethereum token bridge the tests' bridge pins.
const TEST_ETH_TOKEN_BRIDGE_ADDRESS: Address = Address::repeat_byte(0x22);

fn load_proofs() -> Vec<LoadedProof> {
    load_update_proofs_dir(PROOFS_DIR).expect("example proofs must parse")
}

fn outputs(proof: &LoadedProof) -> ProofOutputs {
    proof.outputs().expect("public values decode")
}

struct AnvilHarness {
    // Field exists only for its Drop; must outlive the test.
    _anvil: Anvil,
    submitter: TempoProofSubmitter,
    deployed: DeployedTempoBridge,
}

async fn setup() -> AnvilHarness {
    let proofs = load_proofs();
    setup_with(outputs(&proofs[0]).proof_request_queue_address).await
}

/// Deploy with the first example proof's input store hash, and `eth_proof_queue_address`.
async fn setup_with(eth_proof_queue_address: Address) -> AnvilHarness {
    let anvil = Anvil::start().await;
    let first = outputs(&load_proofs()[0]);
    let submitter =
        TempoProofSubmitter::new(anvil.rpc_url().to_string(), dev_signer(0), Address::ZERO);
    let deployed = submitter
        .deploy_contract(
            first.input_store_hash,
            TEST_ETH_TOKEN_BRIDGE_ADDRESS,
            eth_proof_queue_address,
            B256::from(nori_elf::NORI_SP1_HELIOS_PROGRAM_VK),
            None,
        )
        .await
        .expect("deploy must succeed");
    AnvilHarness {
        _anvil: anvil,
        submitter,
        deployed,
    }
}

async fn read_state(h: &AnvilHarness) -> BridgeState {
    h.submitter.fetch_state().await.expect("state must read")
}

/// The bridge error a failed submission reverted with.
fn expect_bridge_error(
    result: Result<TempoTransactionResult, SubmitterError>,
) -> NoriTempoTokenBridgeErrors {
    match result.expect_err("submission must fail") {
        SubmitterError::BridgeRevert(error) => error,
        other => panic!("expected a bridge revert, got {other:?}"),
    }
}

#[tokio::test]
async fn deploy_starts_at_head_zero_with_the_store_hash() {
    let h = setup().await;
    let first = outputs(&load_proofs()[0]);
    assert_eq!(h.submitter.bridge_address(), h.deployed.bridge);
    let state = read_state(&h).await;
    assert_eq!(state.latestHead, 0);
    assert_eq!(state.queueCursor, 0);
    assert_eq!(state.proofQueueBatchCount, 0);
    assert_eq!(state.verifiedStateRoot, B256::ZERO);
    assert_eq!(state.latestHeliosStoreInputHash, first.input_store_hash);
    assert_eq!(
        state.ethProofQueueAddress,
        first.proof_request_queue_address
    );
    assert_eq!(state.ethTokenBridgeAddress, TEST_ETH_TOKEN_BRIDGE_ADDRESS);
    assert_eq!(
        state.noriBridgeVk,
        B256::from(nori_elf::NORI_SP1_HELIOS_PROGRAM_VK)
    );
}

#[tokio::test]
async fn submit_single_update_advances_state() {
    let h = setup().await;
    let proofs = load_proofs();
    let result = h
        .submitter
        .submit_update(&proofs[0].wire)
        .await
        .expect("first update must succeed");
    assert!(!result.tx_hash.is_empty());

    let state = read_state(&h).await;
    let out = outputs(&proofs[0]);
    assert_eq!(state.latestHead, SLOT_1);
    assert_eq!(state.verifiedStateRoot, out.execution_state_root);
    assert_eq!(state.latestHeliosStoreInputHash, out.output_store_hash);
    assert_eq!(state.queueCursor, out.output_queue_cursor);
    assert_eq!(out.output_block_number, BLOCK_1);

    // The example proofs drain no requests (empty batch): the update only
    // advances the head and commits no proof queue batch.
    assert_eq!(out.input_queue_cursor, out.output_queue_cursor);
    assert_eq!(state.proofQueueBatchCount, 0);
}

#[tokio::test]
async fn submit_update_series() {
    let h = setup().await;
    let proofs = load_proofs();
    let heads = [SLOT_1, SLOT_2, SLOT_3, SLOT_4];
    for (i, proof) in proofs.iter().enumerate() {
        let result = h
            .submitter
            .submit_update(&proof.wire)
            .await
            .unwrap_or_else(|e| panic!("update {i} failed: {e}"));
        let gas = result.gas_used.expect("receipts carry gas used");
        println!("update[{i}]: {gas} gas");
        let state = read_state(&h).await;
        assert_eq!(state.latestHead, heads[i]);
        assert_eq!(state.proofQueueBatchCount, 0);
    }
}

#[tokio::test]
async fn skipping_a_transition_fails_continuity() {
    let h = setup().await;
    let proofs = load_proofs();
    h.submitter
        .submit_update(&proofs[0].wire)
        .await
        .expect("first update must succeed");
    let error = expect_bridge_error(h.submitter.submit_update(&proofs[2].wire).await);
    assert!(matches!(
        error,
        NoriTempoTokenBridgeErrors::InputStoreHashMismatch(_)
    ));

    // State is untouched by the failed transaction.
    let state = read_state(&h).await;
    assert_eq!(state.latestHead, SLOT_1);
    assert_eq!(state.proofQueueBatchCount, 0);
}

#[tokio::test]
async fn replaying_a_proof_fails() {
    let h = setup().await;
    let proofs = load_proofs();
    h.submitter
        .submit_update(&proofs[0].wire)
        .await
        .expect("first update must succeed");
    let error = expect_bridge_error(h.submitter.submit_update(&proofs[0].wire).await);
    assert!(matches!(
        error,
        NoriTempoTokenBridgeErrors::InputStoreHashMismatch(_)
    ));
}

#[tokio::test]
async fn update_with_wrong_queue_address_fails() {
    let h = setup_with(Address::repeat_byte(0xEE)).await;
    let proofs = load_proofs();
    let error = expect_bridge_error(h.submitter.submit_update(&proofs[0].wire).await);
    assert!(matches!(
        error,
        NoriTempoTokenBridgeErrors::ETHProofQueueAddressMismatch(_)
    ));
}
