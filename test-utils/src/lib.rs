//! Shared harness for tests that run against a local Tempo node
//! (`anvil --network tempo`): start a node on a free port with kill-on-drop,
//! sign with its funded dev accounts, write contract storage and move the
//! clock with anvil's cheatcodes.
//!
//! Requires `anvil` (Foundry, see DEVELOPMENT_GUIDE.md) on PATH.

use {
    alloy::{
        primitives::{Address, B256, U256},
        providers::{Provider, ProviderBuilder},
        signers::local::PrivateKeySigner,
    },
    std::{
        net::TcpListener,
        process::{Child, Command, Stdio},
        time::Duration,
    },
    tokio::time::Instant,
};

/// How long [`Anvil::start`] waits for the node's RPC to answer.
const ANVIL_READY_TIMEOUT: Duration = Duration::from_secs(30);

const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Private keys of anvil's first dev accounts (the `test test ... junk`
/// mnemonic). On `anvil --network tempo` each holds pathUSD, Tempo's default
/// fee token.
const DEV_PRIVATE_KEYS: [&str; 3] = [
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a826b4ff4fd8",
];

/// A free local TCP port (bound and released, so another process could
/// still take it before it is used).
pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// A running `anvil --network tempo` node on a free port. Killed when
/// dropped, so a panicking test does not leak it.
pub struct Anvil {
    child: Child,
    rpc_url: String,
    ws_url: String,
}

impl Anvil {
    /// Start a node and wait until its RPC answers.
    ///
    /// The child is owned by the guard from the moment it spawns, so a panic
    /// while waiting (or anywhere later in the test) still kills it.
    pub async fn start() -> Self {
        let port = free_port();
        let child = Command::new("anvil")
            .args(["--network", "tempo", "--port", &port.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn anvil (is Foundry on PATH?)");
        let anvil = Self {
            child,
            rpc_url: format!("http://127.0.0.1:{port}"),
            ws_url: format!("ws://127.0.0.1:{port}"),
        };
        assert!(
            rpc_ready(&anvil.rpc_url, ANVIL_READY_TIMEOUT).await,
            "anvil did not come up on {}",
            anvil.rpc_url
        );
        anvil
    }

    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
    }

    /// The websocket endpoint, served on the same port as http.
    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    /// Process id of the node, for callers that must kill it outside of
    /// drop (e.g. on Ctrl-C).
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// A provider over the node's RPC, for reads and cheatcodes.
    pub fn provider(&self) -> impl Provider {
        ProviderBuilder::new().connect_http(self.rpc_url.parse().expect("anvil rpc url"))
    }
}

impl Drop for Anvil {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Poll `eth_chainId` until it succeeds or `timeout` elapses.
pub async fn rpc_ready(rpc_url: &str, timeout: Duration) -> bool {
    let provider = ProviderBuilder::new().connect_http(rpc_url.parse().expect("rpc url"));
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if provider.get_chain_id().await.is_ok() {
            return true;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    false
}

/// The signer of anvil's dev account `index` (0, 1 or 2), funded with the
/// node's fee token.
pub fn dev_signer(index: usize) -> PrivateKeySigner {
    DEV_PRIVATE_KEYS[index]
        .parse()
        .expect("anvil dev private key")
}

/// Write one storage word of `address` with anvil's `anvil_setStorageAt`
/// cheatcode.
pub async fn set_storage_at(provider: &impl Provider, address: Address, slot: U256, value: B256) {
    provider
        .raw_request::<_, bool>(
            "anvil_setStorageAt".into(),
            (address, B256::from(slot), value),
        )
        .await
        .unwrap_or_else(|e| panic!("anvil_setStorageAt: {e}"));
}

/// Move the node clock to `unix_time` (seconds) with anvil's
/// `evm_setNextBlockTimestamp` and `evm_mine` cheatcodes. Time only moves
/// forward.
pub async fn time_travel(provider: &impl Provider, unix_time: u64) {
    provider
        .raw_request::<_, serde_json::Value>("evm_setNextBlockTimestamp".into(), (unix_time,))
        .await
        .unwrap_or_else(|e| panic!("evm_setNextBlockTimestamp: {e}"));
    provider
        .raw_request::<_, serde_json::Value>("evm_mine".into(), ())
        .await
        .unwrap_or_else(|e| panic!("evm_mine: {e}"));
}
