import "dotenv/config";
import { type HardhatUserConfig } from "hardhat/config";
import hardhatTypechain from "@nomicfoundation/hardhat-typechain";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatEthersChaiMatchers from "@nomicfoundation/hardhat-ethers-chai-matchers";
import hardhatMocha from "@nomicfoundation/hardhat-mocha";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "./logger.js";
import { Logger } from "esm-iso-logger";

const logger = new Logger("HardhatConfig");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import "./tasks/lockTokens.js";
import "./tasks/getTotalDeposited.js";
import "./tasks/deploy.js";
import "./tasks/getFeeInfo.js";
import "./tasks/setFeeRate.js";
import "./tasks/setFeeRecipient.js";
import "./tasks/withdrawFees.js";
import "./tasks/setBridgeOperator.js";
import "./tasks/setProofRequestQueueFee.js";
import "./tasks/withdrawProofRequestQueueFees.js";
import "./tasks/previewFees.js";

import { lockTokens } from "./tasks/lockTokens.js";
import { getTotalDeposited } from "./tasks/getTotalDeposited.js";
import { deploy } from "./tasks/deploy.js";
import { getFeeInfo } from "./tasks/getFeeInfo.js";
import { setFeeRate } from "./tasks/setFeeRate.js";
import { setFeeRecipient } from "./tasks/setFeeRecipient.js";
import { withdrawFees } from "./tasks/withdrawFees.js";
import { setBridgeOperator } from "./tasks/setBridgeOperator.js";
import { deployTimelock } from "./tasks/deployTimelock.js";
import { setProofRequestQueueFee } from "./tasks/setProofRequestQueueFee.js";
import { withdrawProofRequestQueueFees } from "./tasks/withdrawProofRequestQueueFees.js";
import { previewFees } from "./tasks/previewFees.js";
import { lockERC20 } from "./tasks/lockERC20.js";
import { syncPause } from "./tasks/syncPause.js";
import { withdrawTokenFees } from "./tasks/withdrawTokenFees.js";
import { fundFromHolder } from "./tasks/fundFromHolder.js";

const possibleNetworkName = process.env.ETH_NETWORK;
const possibleRpcUrl = process.env.ETH_RPC_URL;
const possiblePrivateKey = process.env.ETH_PRIVATE_KEY;

const issues: string[] = [];

if (!possibleNetworkName) issues.push("Missing required env: ETH_NETWORK");
if (possibleNetworkName && possibleNetworkName !== "hardhat") {
  if (!possibleRpcUrl) issues.push("Missing required env: ETH_RPC_URL");
  if (!possiblePrivateKey) issues.push("Missing required env: ETH_PRIVATE_KEY");
}

if (issues.length) {
  logger.error("HardhatConfig encountered errors:");
  issues.forEach((issue, idx) => logger.warn(`  ${idx + 1}: ${issue}`));
  logger.fatal(
    "Due to issues with environment variables hardhat cannot continue."
  );
  process.exit(1);
}

const networkName = possibleNetworkName as string;

// Public, non-archive: forks at a recent block work, pinned old blocks do not.
const DEFAULT_MAINNET_FORK_RPC_URL = "https://ethereum-rpc.publicnode.com";

const networks: NonNullable<HardhatUserConfig["networks"]> = {
  // Simulated network forked from Ethereum mainnet, for test-fork/ and node:fork
  mainnetFork: {
    type: "edr-simulated",
    chainType: "l1",
    forking: {
      url: process.env.ETH_MAINNET_FORK_RPC_URL || DEFAULT_MAINNET_FORK_RPC_URL,
      ...(process.env.ETH_MAINNET_FORK_BLOCK && {
        blockNumber: BigInt(process.env.ETH_MAINNET_FORK_BLOCK),
      }),
    },
  },
};

if (networkName !== "hardhat") {
  networks[networkName] = {
    url: possibleRpcUrl as string,
    accounts: [possiblePrivateKey as string],
    type: "http",
  };
}

logger.log(`Running on network "${networkName}"`);
if (networkName === "hardhat") {
  logger.log("Using built-in Hardhat network for local testing.");
} else {
  logger.log(`Using RPC URL: ${possibleRpcUrl}`);
  logger.log("One private key loaded for deployment.");
}

/**
 * Loads Foundry-style remappings from remappings.txt
 * Returns an array of "prefix=target" strings for solc settings
 */
function loadRemappings(): string[] {
  const remappingsPath = path.join(__dirname, "remappings.txt");

  if (!fs.existsSync(remappingsPath)) {
    return [];
  }

  const content = fs.readFileSync(remappingsPath, "utf8");
  const remappings: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    remappings.push(trimmed);
  }

  return remappings;
}

const config: HardhatUserConfig = {
  networks,
  tasks: [
    lockTokens,
    getTotalDeposited,
    deploy,
    deployTimelock,
    getFeeInfo,
    setFeeRate,
    setFeeRecipient,
    withdrawFees,
    setBridgeOperator,
    setProofRequestQueueFee,
    withdrawProofRequestQueueFees,
    previewFees,
    lockERC20,
    syncPause,
    withdrawTokenFees,
    fundFromHolder,
  ],
  plugins: [
    hardhatMocha,
    hardhatTypechain,
    hardhatEthers,
    hardhatEthersChaiMatchers,
  ],
  solidity: {
    version: "0.8.28",
    settings: {
      remappings: loadRemappings(),
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  test: {
    mocha: {
      rootHooks: {
        afterAll() {
          // Force exit after tests — ethers .once() listeners keep the process alive
          setTimeout(() => process.exit(0), 100);
        },
      },
    },
  },
  paths: {
    sources: "./contracts",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
