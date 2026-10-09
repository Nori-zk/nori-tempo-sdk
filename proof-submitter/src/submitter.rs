//! Builds and submits `update` transactions for the Nori Tempo token bridge,
//! and deploys the bridge.
//!
//! Interface mirrors the bridge head's other destination-chain submitters:
//! construct from env ([`TempoProofSubmitter::from_env`]), then call
//! [`TempoProofSubmitter::submit_update`] per proof batch.

use alloy::{
    network::EthereumWallet,
    primitives::{keccak256, Address, Bytes, B256},
    providers::{Provider, ProviderBuilder},
    rpc::types::TransactionReceipt,
    signers::local::PrivateKeySigner,
};
use std::{str::FromStr, sync::RwLock};

use crate::bridge::{
    ITIP20Factory,
    NoriTempoTokenBridge::{self, BridgeState, NoriTempoTokenBridgeErrors},
    SP1Verifier, ITIP20, PATH_USD_ADDRESS, TIP20_FACTORY_ADDRESS,
};
use crate::proof_file::UpdateProof;

/// The bridged token: symbol nETH, currency ETH, so it is not a fee token.
const TOKEN_NAME: &str = "nETH";
const TOKEN_SYMBOL: &str = "nETH";
const TOKEN_CURRENCY: &str = "ETH";

/// Minimal result; mirrors the mock shape from the bridge-head side so
/// call sites can swap implementations.
#[derive(Debug, Clone)]
pub struct TempoTransactionResult {
    /// Transaction hash.
    pub tx_hash: String,
    /// Gas the transaction used, from its receipt.
    pub gas_used: Option<u64>,
}

/// The contracts [`TempoProofSubmitter::deploy_contract`] deployed or used.
#[derive(Debug, Clone)]
pub struct DeployedTempoBridge {
    /// The SP1 Groth16 verifier the bridge verifies with.
    pub verifier: Address,
    /// The bridged TIP-20, created through `TIP20Factory`.
    pub token: Address,
    /// The `NoriTempoTokenBridge`, holding `ISSUER_ROLE` on the token.
    pub bridge: Address,
    /// The block the bridge was deployed in.
    pub bridge_deploy_block: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum SubmitterError {
    #[error("env: {0}")]
    Env(#[from] std::env::VarError),
    #[error("invalid TEMPO_RPC_NETWORK_URL: {0}")]
    RpcUrl(String),
    #[error("invalid TEMPO_PRIVATE_KEY: {0}")]
    PrivateKey(String),
    #[error("invalid NORI_TEMPO_TOKEN_BRIDGE_ADDRESS: {0}")]
    BridgeAddress(String),
    #[error("bridge rejected the call: {0:?}")]
    BridgeRevert(NoriTempoTokenBridgeErrors),
    #[error("contract call: {0}")]
    Contract(alloy::contract::Error),
    #[error("rpc: {0}")]
    Rpc(#[from] alloy::transports::TransportError),
    #[error("waiting for the transaction: {0}")]
    PendingTransaction(#[from] alloy::providers::PendingTransactionError),
    #[error("transaction {tx_hash} reverted")]
    Reverted { tx_hash: String },
    #[error("{what} transaction {tx_hash} has no contract address in its receipt")]
    MissingContractAddress { what: &'static str, tx_hash: String },
}

impl From<alloy::contract::Error> for SubmitterError {
    /// A revert carrying one of the bridge's errors decodes to it; anything
    /// else is kept as the contract call error.
    fn from(error: alloy::contract::Error) -> Self {
        match error.as_decoded_interface_error::<NoriTempoTokenBridgeErrors>() {
            Some(decoded) => Self::BridgeRevert(decoded),
            None => Self::Contract(error),
        }
    }
}

pub struct TempoProofSubmitter {
    rpc_url: String,
    signer: PrivateKeySigner,
    bridge_address: RwLock<Address>,
}

impl TempoProofSubmitter {
    /// Env:
    /// * `TEMPO_RPC_NETWORK_URL` (required)
    /// * `TEMPO_PRIVATE_KEY` (required): the sender, holding a fee token balance
    /// * `NORI_TEMPO_TOKEN_BRIDGE_ADDRESS` (required): the deployed `NoriTempoTokenBridge`
    pub fn from_env() -> Result<Self, SubmitterError> {
        dotenvy::dotenv().ok();
        let rpc_url = std::env::var("TEMPO_RPC_NETWORK_URL")?;
        let signer = read_private_key(&std::env::var("TEMPO_PRIVATE_KEY")?)?;
        let raw_bridge = std::env::var("NORI_TEMPO_TOKEN_BRIDGE_ADDRESS")?;
        let bridge_address = Address::from_str(&raw_bridge)
            .map_err(|_| SubmitterError::BridgeAddress(raw_bridge))?;
        Ok(Self::new(rpc_url, signer, bridge_address))
    }

    pub fn new(rpc_url: String, signer: PrivateKeySigner, bridge_address: Address) -> Self {
        Self {
            rpc_url,
            signer,
            bridge_address: RwLock::new(bridge_address),
        }
    }

    pub fn sender_address(&self) -> Address {
        self.signer.address()
    }

    /// The bridge this submitter updates; [`Self::deploy_contract`] points it
    /// at the bridge it deploys.
    pub fn bridge_address(&self) -> Address {
        *self
            .bridge_address
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
    }

    /// A provider over the configured RPC that signs with the sender.
    fn provider(&self) -> Result<impl Provider, SubmitterError> {
        let url = self
            .rpc_url
            .parse()
            .map_err(|_| SubmitterError::RpcUrl(self.rpc_url.clone()))?;
        Ok(ProviderBuilder::new()
            .wallet(EthereumWallet::from(self.signer.clone()))
            .connect_http(url))
    }

    /// Read the bridge's whole state: head, store hash, queue cursor and
    /// proof queue batch count among it.
    pub async fn fetch_state(&self) -> Result<BridgeState, SubmitterError> {
        let provider = self.provider()?;
        let bridge = NoriTempoTokenBridge::new(self.bridge_address(), &provider);
        Ok(bridge.state().call().await?)
    }

    /// Submit one proof batch as an `update` transaction and wait for its
    /// receipt. If another update lands first, the contract's continuity
    /// checks reject this one.
    pub async fn submit_update(
        &self,
        proof: &UpdateProof,
    ) -> Result<TempoTransactionResult, SubmitterError> {
        let provider = self.provider()?;
        let bridge = NoriTempoTokenBridge::new(self.bridge_address(), &provider);
        let receipt = bridge
            .update(
                Bytes::from(proof.proof.clone()),
                Bytes::from(proof.sp1_public_inputs.clone()),
            )
            .send()
            .await?
            .get_receipt()
            .await?;
        self.transaction_result(&receipt, "update")
    }

    /// Deploy the bridge and its token, in order: the sp1-contracts v6.1.0
    /// Groth16 verifier unless `verifier` is given, the nETH TIP-20 through
    /// `TIP20Factory` with the sender as admin and pathUSD as its quote token,
    /// the `NoriTempoTokenBridge`, then `ISSUER_ROLE` on the token for the
    /// bridge. The bridge starts at head 0 and cursor 0; its first `update`
    /// is any proof whose input store hash is `store_hash`. This submitter
    /// then updates the deployed bridge.
    pub async fn deploy_contract(
        &self,
        store_hash: B256,
        eth_token_bridge_address: Address,
        eth_proof_queue_address: Address,
        nori_bridge_vk: B256,
        verifier: Option<Address>,
    ) -> Result<DeployedTempoBridge, SubmitterError> {
        let verifier = match verifier {
            Some(verifier) => verifier,
            None => self.deploy_verifier().await?,
        };
        let token = self.create_token().await?;
        let (bridge, bridge_deploy_block) = self
            .deploy_bridge(
                verifier,
                token,
                nori_bridge_vk,
                store_hash,
                eth_token_bridge_address,
                eth_proof_queue_address,
            )
            .await?;
        self.grant_issuer_role(token, bridge).await?;
        *self
            .bridge_address
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = bridge;
        Ok(DeployedTempoBridge {
            verifier,
            token,
            bridge,
            bridge_deploy_block,
        })
    }

    /// Deploy the sp1-contracts v6.1.0 Groth16 `SP1Verifier`.
    pub async fn deploy_verifier(&self) -> Result<Address, SubmitterError> {
        let provider = self.provider()?;
        let receipt = SP1Verifier::deploy_builder(&provider)
            .send()
            .await?
            .get_receipt()
            .await?;
        self.transaction_result(&receipt, "SP1Verifier deploy")?;
        contract_address(&receipt, "SP1Verifier deploy")
    }

    /// Create the nETH TIP-20 through `TIP20Factory`, with the sender as
    /// admin and pathUSD as its quote token. The salt is the hash of the
    /// sender and its nonce, so each call creates a new token.
    pub async fn create_token(&self) -> Result<Address, SubmitterError> {
        let provider = self.provider()?;
        let sender = self.sender_address();
        let nonce = provider.get_transaction_count(sender).await?;
        let salt = keccak256([sender.as_slice(), &nonce.to_be_bytes()].concat());
        let factory = ITIP20Factory::new(TIP20_FACTORY_ADDRESS, &provider);
        let create = factory.createToken(
            TOKEN_NAME.to_string(),
            TOKEN_SYMBOL.to_string(),
            TOKEN_CURRENCY.to_string(),
            PATH_USD_ADDRESS,
            sender,
            salt,
        );
        let token = create.call().await?;
        let receipt = create.send().await?.get_receipt().await?;
        self.transaction_result(&receipt, "TIP-20 create")?;
        Ok(token)
    }

    /// Deploy the `NoriTempoTokenBridge`, returning its address and the
    /// block it was deployed in.
    pub async fn deploy_bridge(
        &self,
        verifier: Address,
        token: Address,
        nori_bridge_vk: B256,
        store_hash: B256,
        eth_token_bridge_address: Address,
        eth_proof_queue_address: Address,
    ) -> Result<(Address, u64), SubmitterError> {
        let provider = self.provider()?;
        let receipt = NoriTempoTokenBridge::deploy_builder(
            &provider,
            verifier,
            nori_bridge_vk,
            token,
            store_hash,
            eth_token_bridge_address,
            eth_proof_queue_address,
        )
        .send()
        .await?
        .get_receipt()
        .await?;
        self.transaction_result(&receipt, "NoriTempoTokenBridge deploy")?;
        let bridge = contract_address(&receipt, "NoriTempoTokenBridge deploy")?;
        Ok((bridge, receipt.block_number.unwrap_or_default()))
    }

    /// Grant `bridge` the token's `ISSUER_ROLE`, so only it mints.
    pub async fn grant_issuer_role(
        &self,
        token: Address,
        bridge: Address,
    ) -> Result<TempoTransactionResult, SubmitterError> {
        let provider = self.provider()?;
        let receipt = ITIP20::new(token, &provider)
            .grantRole(keccak256("ISSUER_ROLE"), bridge)
            .send()
            .await?
            .get_receipt()
            .await?;
        self.transaction_result(&receipt, "ISSUER_ROLE grant")
    }

    /// Shared receipt check: a reverted transaction is an error, a
    /// successful one is logged with its gas.
    fn transaction_result(
        &self,
        receipt: &TransactionReceipt,
        what: &str,
    ) -> Result<TempoTransactionResult, SubmitterError> {
        let tx_hash = receipt.transaction_hash.to_string();
        if !receipt.status() {
            return Err(SubmitterError::Reverted { tx_hash });
        }
        log::info!(
            "submitted Nori {what} tx {} through {} ({} gas)",
            tx_hash,
            self.rpc_url,
            receipt.gas_used
        );
        Ok(TempoTransactionResult {
            tx_hash,
            gas_used: Some(receipt.gas_used),
        })
    }
}

/// The contract a deploy transaction created.
fn contract_address(
    receipt: &TransactionReceipt,
    what: &'static str,
) -> Result<Address, SubmitterError> {
    receipt
        .contract_address
        .ok_or_else(|| SubmitterError::MissingContractAddress {
            what,
            tx_hash: receipt.transaction_hash.to_string(),
        })
}

/// A hex private key, with or without its `0x` prefix.
pub fn read_private_key(raw: &str) -> Result<PrivateKeySigner, SubmitterError> {
    PrivateKeySigner::from_str(raw.trim()).map_err(|e| SubmitterError::PrivateKey(e.to_string()))
}
