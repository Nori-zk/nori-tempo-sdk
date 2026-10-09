//! Alloy bindings for the Tempo contracts, generated from their Hardhat
//! artifacts (ABI and bytecode) in `tempo/artifacts/`: `NoriTempoTokenBridge`,
//! the sp1-contracts v6.1.0 Groth16 `SP1Verifier` (from the pinned library)
//! for networks without Succinct's, and the TIP-20 interfaces.

use alloy::{primitives::Address, sol};

sol!(
    #[sol(rpc, all_derives)]
    NoriTempoTokenBridge,
    "../tempo/artifacts/contracts/NoriTempoTokenBridge.sol/NoriTempoTokenBridge.json"
);

sol!(
    #[sol(rpc)]
    SP1Verifier,
    "../tempo/artifacts/lib/sp1-contracts/contracts/src/v6.1.0/SP1VerifierGroth16.sol/SP1Verifier.json"
);

sol!(
    #[sol(rpc)]
    ITIP20,
    "../tempo/artifacts/contracts/interfaces/ITIP20.sol/ITIP20.json"
);

sol!(
    #[sol(rpc)]
    ITIP20Factory,
    "../tempo/artifacts/contracts/interfaces/ITIP20Factory.sol/ITIP20Factory.json"
);

/// Tempo's `TIP20Factory` precompile.
pub const TIP20_FACTORY_ADDRESS: Address =
    alloy::primitives::address!("20Fc000000000000000000000000000000000000");

/// pathUSD, the TIP-20 every network has at this address (mainnet, Moderato
/// and a local `anvil --network tempo`); the quote token the bridged token is
/// created with.
pub const PATH_USD_ADDRESS: Address =
    alloy::primitives::address!("20C0000000000000000000000000000000000000");
