//! Operator CLI for the Nori Tempo token bridge.
//!
//! Wraps [`proof_submitter::TempoProofSubmitter`]; run from the repo root
//! with `cargo run -p nori-cli -- <command> --help`.

use alloy::{
    primitives::{hex, Address, B256},
    providers::{Provider, ProviderBuilder},
};
use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use proof_submitter::{read_private_key, TempoProofSubmitter};
use std::io::{BufRead, Write};

#[derive(Parser)]
#[command(
    name = "nori-cli",
    about = "Operator commands for the Nori Tempo token bridge"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Deploy the bridge: the SP1 v6.1.0 Groth16 verifier (unless one is
    /// given), the nETH TIP-20 through TIP20Factory, the
    /// `NoriTempoTokenBridge`, and `ISSUER_ROLE` on the token for the bridge.
    /// The bridge starts at head 0 and cursor 0.
    Deploy(DeployArgs),
}

/// RPC endpoint and sender. Each flag falls back to the env var the proof
/// submitter reads (`.env` in the working directory is loaded too).
#[derive(Args)]
struct Connection {
    /// Tempo JSON-RPC endpoint.
    // hide_env_values: --help would otherwise print the URL's API key.
    #[arg(
        short = 'u',
        long = "url",
        env = "TEMPO_RPC_NETWORK_URL",
        hide_env_values = true
    )]
    rpc_url: String,

    /// Sender private key (hex). Pays fees in its fee token and becomes the
    /// token's admin.
    #[arg(
        short = 'k',
        long = "private-key",
        env = "TEMPO_PRIVATE_KEY",
        hide_env_values = true
    )]
    private_key: String,
}

/// The deploy inputs: the Helios store hash the first proof's input store
/// hash must match, and the Ethereum contracts the bridge pins.
#[derive(Args)]
struct DeployArgs {
    #[command(flatten)]
    connection: Connection,

    /// Helios store hash the first proof's input store hash must match.
    #[arg(value_name = "STORE_HASH_HEX")]
    store_hash: B256,

    /// `NoriTokenBridge` address on Ethereum.
    #[arg(value_name = "ETH_TOKEN_BRIDGE_ADDRESS_HEX")]
    eth_token_bridge_address: Address,

    /// `NoriProofRequestQueue` address on Ethereum.
    #[arg(value_name = "ETH_PROOF_QUEUE_ADDRESS_HEX")]
    eth_proof_queue_address: Address,

    /// Succinct's SP1 v6.1.0 Groth16 verifier or gateway, where one is
    /// deployed; without it, or empty, sp1-contracts' v6.1.0 verifier is
    /// deployed.
    #[arg(long, env = "TEMPO_SP1_VERIFIER_ADDRESS")]
    verifier: Option<String>,

    /// Run the checks and print the summary without sending.
    #[arg(long)]
    dry_run: bool,

    /// Send without the confirmation prompt.
    #[arg(short = 'y', long)]
    yes: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    match Cli::parse().command {
        Command::Deploy(args) => deploy(args).await,
    }
}

async fn deploy(args: DeployArgs) -> Result<()> {
    let Connection {
        rpc_url,
        private_key,
    } = args.connection;
    let signer = read_private_key(&private_key)?;
    let verifier = verifier_address(args.verifier.as_deref())?;
    let endpoint = redact_query(&rpc_url).to_string();
    let provider = ProviderBuilder::new().connect_http(
        rpc_url
            .parse()
            .with_context(|| format!("invalid url {endpoint}"))?,
    );
    let chain_id = provider
        .get_chain_id()
        .await
        .with_context(|| format!("reading the chain id from {endpoint}"))?;
    let nori_bridge_vk = B256::from(nori_elf::NORI_SP1_HELIOS_PROGRAM_VK);

    let submitter = TempoProofSubmitter::new(rpc_url, signer, Address::ZERO);

    println!("Nori bridge deploy");
    println!("  rpc                             {endpoint}");
    println!("  chain id                        {chain_id}");
    println!(
        "  sender / token admin            {}",
        submitter.sender_address()
    );
    match verifier {
        Some(verifier) => println!("  verifier                        {verifier}"),
        None => println!("  verifier                        (deploying SP1Verifier v6.1.0)"),
    }
    println!("deploy inputs");
    println!("  store_hash                      {}", args.store_hash);
    println!(
        "  eth_token_bridge_address        {}",
        args.eth_token_bridge_address
    );
    println!(
        "  eth_proof_queue_address         {}",
        args.eth_proof_queue_address
    );
    println!(
        "  nori_bridge_vk (nori-elf)       0x{}",
        hex::encode(nori_elf::NORI_SP1_HELIOS_PROGRAM_VK)
    );

    if args.dry_run {
        println!("dry run: not sent");
        return Ok(());
    }
    if !args.yes && !confirm("Send the deploy transactions?")? {
        bail!("aborted");
    }

    let deployed = submitter
        .deploy_contract(
            args.store_hash,
            args.eth_token_bridge_address,
            args.eth_proof_queue_address,
            nori_bridge_vk,
            verifier,
        )
        .await
        .context("deploy failed")?;
    println!("NORI_TEMPO_TOKEN_BRIDGE_ADDRESS={}", deployed.bridge);
    println!("NORI_TEMPO_TOKEN_ADDRESS={}", deployed.token);
    println!(
        "NORI_TEMPO_TOKEN_BRIDGE_DEPLOY_BLOCK={}",
        deployed.bridge_deploy_block
    );
    println!("TEMPO_SP1_VERIFIER_ADDRESS={}", deployed.verifier);
    Ok(())
}

/// The verifier to use: `None` when `--verifier` / `TEMPO_SP1_VERIFIER_ADDRESS`
/// is absent or empty.
fn verifier_address(verifier: Option<&str>) -> Result<Option<Address>> {
    match verifier.map(str::trim) {
        None | Some("") => Ok(None),
        Some(address) => address
            .parse()
            .map(Some)
            .with_context(|| format!("invalid verifier address {address}")),
    }
}

/// Endpoint without its query string, which often carries an API key.
fn redact_query(url: &str) -> &str {
    url.split_once('?').map_or(url, |(base, _)| base)
}

fn confirm(question: &str) -> Result<bool> {
    print!("{question} [y/N] ");
    std::io::stdout().flush()?;
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    Ok(matches!(answer.trim(), "y" | "Y" | "yes"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::{error::ErrorKind, CommandFactory};

    const STORE_HASH: &str = "3333333333333333333333333333333333333333333333333333333333333333";
    const ETH_TOKEN_BRIDGE: &str = "2222222222222222222222222222222222222222";
    const ETH_PROOF_QUEUE: &str = "4444444444444444444444444444444444444444";
    const CONNECTION: [&str; 4] = [
        "--url",
        "http://127.0.0.1:8545",
        "--private-key",
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    ];

    fn parse(extra: &[&str]) -> Result<DeployArgs, clap::Error> {
        let mut argv = vec!["nori-cli", "deploy"];
        argv.extend(CONNECTION);
        argv.extend(extra);
        Cli::try_parse_from(argv).map(|cli| match cli.command {
            Command::Deploy(args) => args,
        })
    }

    #[test]
    fn clap_definition_is_valid() {
        Cli::command().debug_assert();
    }

    #[test]
    fn deploy_inputs_without_0x_prefix() {
        let args = parse(&[STORE_HASH, ETH_TOKEN_BRIDGE, ETH_PROOF_QUEUE]).unwrap();
        assert_eq!(args.store_hash, B256::repeat_byte(0x33));
        assert_eq!(args.eth_token_bridge_address, Address::repeat_byte(0x22));
        assert_eq!(args.eth_proof_queue_address, Address::repeat_byte(0x44));
        assert_eq!(verifier_address(args.verifier.as_deref()).unwrap(), None);
    }

    #[test]
    fn empty_verifier_deploys_one() {
        assert_eq!(verifier_address(Some("")).unwrap(), None);
        assert_eq!(
            verifier_address(Some("0xb69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2")).unwrap(),
            Some(alloy::primitives::address!(
                "b69f2584CBcFf99a58C4e7002E8b89Af54a6f4e2"
            ))
        );
        assert!(verifier_address(Some("0x12")).is_err());
    }

    #[test]
    fn deploy_inputs_are_all_required() {
        let err = parse(&[STORE_HASH, ETH_TOKEN_BRIDGE]).err().unwrap();
        assert_eq!(err.kind(), ErrorKind::MissingRequiredArgument);
    }

    #[test]
    fn redacts_query_string() {
        assert_eq!(
            redact_query("https://rpc.example/?api-key=secret"),
            "https://rpc.example/"
        );
        assert_eq!(
            redact_query("http://127.0.0.1:8545"),
            "http://127.0.0.1:8545"
        );
    }
}
