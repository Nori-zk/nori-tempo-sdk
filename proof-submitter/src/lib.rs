//! Client-side proof submission for the Nori Tempo token bridge.
//!
//! Three parts:
//!
//! * [`proof_file`] loads SP1 `SP1ProofWithPublicValues` JSON dumps (as
//!   produced by nori-bridge-head) into `update`'s arguments ([`UpdateProof`]).
//! * [`bridge`] holds the alloy bindings for `NoriTempoTokenBridge`, the SP1
//!   verifier and the TIP-20 interfaces.
//! * [`submitter`] deploys the bridge and sends the `update` transaction
//!   against a Tempo RPC endpoint ([`TempoProofSubmitter`]).

pub mod bridge;
pub mod proof_file;
pub mod submitter;

pub use proof_file::{
    load_update_proof, load_update_proofs_dir, LoadedProof, ProofFileError, UpdateProof,
};
pub use submitter::{
    read_private_key, DeployedTempoBridge, SubmitterError, TempoProofSubmitter,
    TempoTransactionResult,
};
