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
import "./tasks/deploy.js";
import { deploy } from "./tasks/deploy.js";
import { registerMirror } from "./tasks/registerMirror.js";
import { adoptMirror, createIssuerTip20 } from "./tasks/adoptMirror.js";

const possibleNetworkName = process.env.TEMPO_NETWORK;
const possibleRpcUrl = process.env.TEMPO_RPC_NETWORK_URL;
const possiblePrivateKey = process.env.TEMPO_PRIVATE_KEY;

/** A local Tempo node (`anvil --network tempo`), whose unlocked dev accounts sign. */
const LOCALNET = "localnet";
const LOCALNET_RPC_URL = "http://127.0.0.1:8545";

const issues: string[] = [];

if (!possibleNetworkName) issues.push("Missing required env: TEMPO_NETWORK");
if (possibleNetworkName && possibleNetworkName !== "hardhat" && possibleNetworkName !== LOCALNET) {
  if (!possibleRpcUrl) issues.push("Missing required env: TEMPO_RPC_NETWORK_URL");
  if (!possiblePrivateKey) issues.push("Missing required env: TEMPO_PRIVATE_KEY");
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

interface NetworkConfig {
  url: string;
  accounts: string[] | "remote";
  type: "http";
}

const networks: Record<string, NetworkConfig> = {};

if (networkName === LOCALNET) {
  networks[networkName] = {
    url: possibleRpcUrl ?? LOCALNET_RPC_URL,
    accounts: "remote",
    type: "http",
  };
} else if (networkName !== "hardhat") {
  networks[networkName] = {
    url: possibleRpcUrl as string,
    accounts: [possiblePrivateKey as string],
    type: "http",
  };
}

logger.log(`Running on network "${networkName}"`);
if (networkName === "hardhat") {
  logger.log("Using built-in Hardhat network for compiling.");
} else if (networkName === LOCALNET) {
  logger.log(`Using local Tempo node at ${networks[networkName].url} and its unlocked dev accounts.`);
} else {
  logger.log(`Using RPC URL: ${networks[networkName].url}`);
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
  tasks: [deploy, registerMirror, createIssuerTip20, adoptMirror],
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
    // The SP1 verifier comes from the pinned sp1-contracts library
    // (`npm run lib`), compiled here for its artifact.
    sources: {
      solidity: ["./contracts", "./lib/sp1-contracts/contracts/src/v6.1.0"],
    },
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
