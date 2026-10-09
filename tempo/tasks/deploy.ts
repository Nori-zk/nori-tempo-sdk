import { randomBytes } from "crypto";
import { writeFileSync } from "fs";
import { task } from "hardhat/config";
import path from "path";
import { fileURLToPath } from "url";
import "../logger.js";
import { Logger } from "esm-iso-logger";
import { bridgeHeadNoriSP1HeliosProgramVk } from "@nori-zk/tempo-zk-utils";
import {
  ISSUER_ROLE_NAME,
  PATH_USD_ADDRESS,
  TIP20_FACTORY_ADDRESS,
} from "../contracts/interfaces/ITIP20.const.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = new Logger("Deploy");

/** The bridged token: symbol nETH, currency ETH, so it is not a fee token. */
const TOKEN_NAME = "nETH";
const TOKEN_SYMBOL = "nETH";
const TOKEN_CURRENCY = "ETH";
/** The sp1-contracts v6.1.0 Groth16 verifier, from the pinned library; its name alone also matches the Plonk verifier. */
const SP1_VERIFIER_GROTH16 =
  "lib/sp1-contracts/contracts/src/v6.1.0/SP1VerifierGroth16.sol:SP1Verifier";

const isHex = (value: string, length: number) =>
  value.length === length && /^[0-9a-fA-F]+$/.test(value);
const isAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value);

export const deploy = task(
  "deploy",
  "Deploy NoriTempoTokenBridge and its TIP-20, and the SP1 Groth16 verifier when none is given"
)
  .addPositionalArgument({
    name: "storeHashHex",
    description:
      "Helios store hash the first proof's input store hash must match (64 hex characters, no 0x prefix)",
  })
  .addPositionalArgument({
    name: "ethTokenBridgeAddressHex",
    description:
      "Ethereum NoriTokenBridge address (40 hex characters, no 0x prefix)",
  })
  .addPositionalArgument({
    name: "ethProofQueueAddressHex",
    description:
      "Ethereum NoriProofRequestQueue address (40 hex characters, no 0x prefix)",
  })
  .setAction(async () => ({
    default: async (args, hre) => {
      const { ethers } = await hre.network.getOrCreate();
      const { storeHashHex, ethTokenBridgeAddressHex, ethProofQueueAddressHex } =
        args;

      const [deployer] = await ethers.getSigners();
      const network = await ethers.provider.getNetwork();

      const issues: string[] = [];

      if (!isHex(storeHashHex, 64))
        issues.push(
          `storeHashHex '${storeHashHex}' must be exactly 64 hex characters (32 bytes), got ${storeHashHex.length}`
        );
      if (!isHex(ethTokenBridgeAddressHex, 40))
        issues.push(
          `ethTokenBridgeAddressHex '${ethTokenBridgeAddressHex}' must be exactly 40 hex characters (20 bytes), got ${ethTokenBridgeAddressHex.length}`
        );
      if (!isHex(ethProofQueueAddressHex, 40))
        issues.push(
          `ethProofQueueAddressHex '${ethProofQueueAddressHex}' must be exactly 40 hex characters (20 bytes), got ${ethProofQueueAddressHex.length}`
        );

      // Succinct's verifier (or gateway) where one is deployed; otherwise
      // sp1-contracts' v6.1.0 verifier is deployed here.
      const existingVerifier = process.env.TEMPO_SP1_VERIFIER_ADDRESS ?? "";
      if (existingVerifier && !isAddress(existingVerifier))
        issues.push("TEMPO_SP1_VERIFIER_ADDRESS, when set, must be an address");

      if (issues.length) {
        logger.error("Deploy encountered errors:");
        issues.forEach((issue, idx) => logger.warn(`  ${idx + 1}: ${issue}`));
        logger.fatal("Due to issues with the inputs deploy cannot continue.");
        process.exit(1);
      }

      const storeHash = `0x${storeHashHex}`;
      const ethTokenBridgeAddress = ethers.getAddress(`0x${ethTokenBridgeAddressHex}`);
      const ethProofQueueAddress = ethers.getAddress(`0x${ethProofQueueAddressHex}`);

      logger.log(`Deploying with account: ${deployer.address}`);
      logger.log(`Network: ${network.name} (chainId: ${network.chainId})`);
      logger.log(`storeHashHex provided: '${storeHashHex}'`);
      logger.log(`ethTokenBridgeAddressHex provided: '${ethTokenBridgeAddressHex}'`);
      logger.log(`ethProofQueueAddressHex provided: '${ethProofQueueAddressHex}'`);
      logger.log(`Program vkey (integrity): ${bridgeHeadNoriSP1HeliosProgramVk}`);
      logger.log(
        `TEMPO_SP1_VERIFIER_ADDRESS: ${existingVerifier || "(not set, deploying SP1Verifier v6.1.0)"}`
      );

      let verifier = existingVerifier;
      if (!verifier) {
        logger.log("Deploying SP1Verifier (sp1-contracts v6.1.0 Groth16)...");
        const SP1Verifier = await ethers.getContractFactory(SP1_VERIFIER_GROTH16);
        const deployed = await SP1Verifier.deploy();
        const receipt = await deployed.deploymentTransaction()?.wait();
        if (!receipt) throw new Error("SP1Verifier did not deploy");
        verifier = await deployed.getAddress();
        logger.log(`SP1Verifier deployed to: ${verifier}`);
        logger.log(`Gas used: ${receipt.gasUsed.toString()}`);
      }

      // The bridged token, created through TIP20Factory with the deployer as
      // admin and pathUSD as its quote token.
      logger.log(`Creating the ${TOKEN_SYMBOL} TIP-20 through TIP20Factory...`);
      const factory = await ethers.getContractAt("ITIP20Factory", TIP20_FACTORY_ADDRESS);
      const salt = `0x${randomBytes(32).toString("hex")}`;
      const tokenArgs = [TOKEN_NAME, TOKEN_SYMBOL, TOKEN_CURRENCY, PATH_USD_ADDRESS, deployer.address, salt] as const;
      const token = await factory.createToken.staticCall(...tokenArgs);
      const tokenReceipt = await (await factory.createToken(...tokenArgs)).wait();
      if (!tokenReceipt) throw new Error(`${TOKEN_SYMBOL} was not created`);
      logger.log(`${TOKEN_SYMBOL} created at: ${token}`);
      logger.log(`Gas used: ${tokenReceipt.gasUsed.toString()}`);

      logger.log("Deploying NoriTempoTokenBridge...");
      const NoriTempoTokenBridge = await ethers.getContractFactory(
        "NoriTempoTokenBridge"
      );
      const bridge = await NoriTempoTokenBridge.deploy(
        verifier,
        bridgeHeadNoriSP1HeliosProgramVk,
        token,
        storeHash,
        ethTokenBridgeAddress,
        ethProofQueueAddress
      );
      const bridgeReceipt = await bridge.deploymentTransaction()?.wait();
      if (!bridgeReceipt) throw new Error("NoriTempoTokenBridge did not deploy");
      const bridgeAddress = await bridge.getAddress();
      logger.log(`NoriTempoTokenBridge deployed to: ${bridgeAddress}`);
      logger.log(`Deployed in block: ${bridgeReceipt.blockNumber}`);
      logger.log(`Gas used: ${bridgeReceipt.gasUsed.toString()}`);

      // Only the bridge mints the bridged token.
      logger.log(`Granting ISSUER_ROLE on ${TOKEN_SYMBOL} to NoriTempoTokenBridge...`);
      const tip20 = await ethers.getContractAt("ITIP20", token);
      await (await tip20.grantRole(ethers.id(ISSUER_ROLE_NAME), bridgeAddress)).wait();

      const envFilePath = path.resolve(__dirname, "..", ".env.nori-tempo-token-bridge");
      const env = {
        NORI_TEMPO_TOKEN_BRIDGE_ADDRESS: bridgeAddress,
        NORI_TEMPO_TOKEN_ADDRESS: token,
        NORI_TEMPO_TOKEN_BRIDGE_DEPLOY_BLOCK: bridgeReceipt.blockNumber.toString(),
        TEMPO_SP1_VERIFIER_ADDRESS: verifier,
      };
      const envContent =
        Object.entries(env)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n") + "\n";
      writeFileSync(envFilePath, envContent, { encoding: "utf8" });

      logger.log(`Wrote ${envFilePath}`);
      logger.log("Environment variables for future use:");
      for (const [key, value] of Object.entries(env)) {
        logger.log(`${key}=${value}`);
      }
    },
  }))
  .build();
