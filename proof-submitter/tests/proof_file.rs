//! Host-side tests: proof JSON loading, chain-continuity of the example
//! series, loader error reporting, and `from_env` validation. No node
//! required.

use {
    alloy_primitives::B256,
    nori_sp1_helios_primitives::types::ProofOutputs,
    proof_submitter::{
        load_update_proof, load_update_proofs_dir, proof_file::SP1_GROTH16_PROOF_LEN, LoadedProof,
        ProofFileError, TempoProofSubmitter,
    },
};

const PROOFS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/example-proofs");
const SLOTS: [u64; 4] = [11_298_112, 11_298_144, 11_298_176, 11_298_208];

fn load_proofs() -> Vec<LoadedProof> {
    load_update_proofs_dir(PROOFS_DIR).expect("example proofs must parse")
}

fn outputs(proof: &LoadedProof) -> ProofOutputs {
    proof.outputs().expect("public values decode")
}

#[test]
fn example_proofs_load_and_chain() {
    let proofs = load_proofs();
    assert_eq!(proofs.len(), 4);
    let mut prev: Option<ProofOutputs> = None;
    for (i, proof) in proofs.iter().enumerate() {
        assert_eq!(proof.wire.proof.len(), SP1_GROTH16_PROOF_LEN);
        assert_eq!(proof.wire.sp1_public_inputs.len(), 220);
        let out = outputs(proof);
        assert_eq!(out.input_slot, SLOTS[i]);
        assert!(out.output_slot > out.input_slot);
        assert!(out.next_sync_committee_hash != B256::ZERO);
        if let Some(prev) = &prev {
            assert_eq!(out.input_slot, prev.output_slot);
            assert_eq!(out.input_store_hash, prev.output_store_hash);
            assert_eq!(out.input_queue_cursor, prev.output_queue_cursor);
        }
        prev = Some(out);
    }
    // Same proving program across the whole series.
    assert!(proofs
        .iter()
        .all(|p| p.program_vkey == proofs[0].program_vkey));
}

#[test]
fn example_proofs_drain_no_requests() {
    // The integration test data is made against a proof request queue that
    // accepts no requests, so every cursor is 0.
    for proof in load_proofs() {
        let out = outputs(&proof);
        assert_eq!(out.input_queue_cursor, 0);
        assert_eq!(out.output_queue_cursor, 0);
    }
}

#[test]
fn example_proofs_are_made_for_the_nori_elf_vkey() {
    for proof in load_proofs() {
        assert_eq!(proof.program_vkey, nori_elf::NORI_SP1_HELIOS_PROGRAM_VK);
    }
}

#[test]
fn load_update_proof_reports_bad_files() {
    let good = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/example-proofs/11298112-v6.1.0.json"
    ))
    .unwrap();

    let dir = std::env::temp_dir().join(format!("nori-bad-proof-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    let bad_json = dir.join("bad.json");
    std::fs::write(&bad_json, "{\"proof\":{}}").unwrap();
    assert!(matches!(
        load_update_proof(&bad_json),
        Err(ProofFileError::Json(_))
    ));

    // Truncated encoded proof.
    let mut parsed: serde_json::Value = serde_json::from_str(&good).unwrap();
    parsed["proof"]["Groth16"]["encoded_proof"] = serde_json::Value::String("00ff".into());
    let short = dir.join("short.json");
    std::fs::write(&short, serde_json::to_string(&parsed).unwrap()).unwrap();
    assert!(matches!(
        load_update_proof(&short),
        Err(ProofFileError::EncodedProofLength { got: 2, .. })
    ));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn from_env_requires_url_key_and_bridge() {
    let url = std::env::var("TEMPO_RPC_NETWORK_URL").ok();
    let key = std::env::var("TEMPO_PRIVATE_KEY").ok();
    let bridge = std::env::var("NORI_TEMPO_TOKEN_BRIDGE_ADDRESS").ok();
    std::env::remove_var("TEMPO_RPC_NETWORK_URL");
    std::env::remove_var("TEMPO_PRIVATE_KEY");
    std::env::remove_var("NORI_TEMPO_TOKEN_BRIDGE_ADDRESS");
    assert!(TempoProofSubmitter::from_env().is_err());

    std::env::set_var("TEMPO_RPC_NETWORK_URL", "http://127.0.0.1:8545");
    assert!(TempoProofSubmitter::from_env().is_err());

    let restore = |name: &str, value: Option<String>| match value {
        Some(value) => std::env::set_var(name, value),
        None => std::env::remove_var(name),
    };
    restore("TEMPO_RPC_NETWORK_URL", url);
    restore("TEMPO_PRIVATE_KEY", key);
    restore("NORI_TEMPO_TOKEN_BRIDGE_ADDRESS", bridge);
}
