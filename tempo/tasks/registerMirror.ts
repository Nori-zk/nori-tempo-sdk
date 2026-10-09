import { randomBytes } from "crypto";
import { task } from "hardhat/config";
import "../logger.js";
import { Logger } from "esm-iso-logger";

const logger = new Logger("RegisterMirror");

export const registerMirror = task(
  "registerMirror",
  "Create the TIP-20 mirror of an Ethereum ERC-20 on NoriTempoTokenBridge (the bridge's deployer only)"
)
  .addPositionalArgument({
    name: "ethToken",
    description: "The Ethereum ERC-20's address (0x-prefixed)",
  })
  .addPositionalArgument({
    name: "name",
    description: "The mirror's name",
  })
  .addPositionalArgument({
    name: "symbol",
    description: "The mirror's symbol",
  })
  .addPositionalArgument({
    name: "currency",
    description: 'The mirror\'s TIP-20 currency; "USD" lets it pay Tempo fees',
  })
  .setAction(async () => ({
    default: async ({ ethToken, name, symbol, currency }, hre) => {
      const { ethers } = await hre.network.getOrCreate();
      const possibleBridgeAddress = process.env.NORI_TEMPO_TOKEN_BRIDGE_ADDRESS;

      const issues: string[] = [];
      if (!possibleBridgeAddress || !ethers.isAddress(possibleBridgeAddress)) {
        issues.push("Missing or invalid env: NORI_TEMPO_TOKEN_BRIDGE_ADDRESS");
      }
      if (!ethers.isAddress(ethToken)) issues.push(`Invalid ethToken address: ${ethToken}`);
      if (issues.length) {
        logger.error("RegisterMirror encountered errors:");
        issues.forEach((issue, idx) => logger.warn(`  ${idx + 1}: ${issue}`));
        logger.fatal("Due to these issues registerMirror cannot continue.");
        process.exit(1);
      }

      const [signer] = await ethers.getSigners();
      const bridge = await ethers.getContractAt("NoriTempoTokenBridge", possibleBridgeAddress as string, signer);
      const salt = `0x${randomBytes(32).toString("hex")}`;
      const receipt = await (await bridge.registerMirror(ethToken, name, symbol, currency, salt)).wait();
      if (!receipt) throw new Error("No tx receipt was generated");
      logger.log(`Mirror of ${ethToken}: ${await bridge.mirrorOf(ethToken)} (${symbol}), block ${receipt.blockNumber}`);
    },
  }))
  .build();
