import { task } from "hardhat/config";
import "../logger.js";
import { Logger } from "esm-iso-logger";

const logger = new Logger("WithdrawTokenFees");

export const withdrawTokenFees = task(
  "withdrawTokenFees",
  "Withdraw the rate fees kept in an ERC-20 to the fee recipient"
)
  .addPositionalArgument({
    name: "token",
    description: "The ERC-20's address (0x-prefixed)",
  })
  .setAction(async () => ({
    default: async ({ token }, hre) => {
      const { ethers } = await hre.network.getOrCreate();
      const possibleDeployedAddress = process.env.NORI_ETH_TOKEN_BRIDGE_ADDRESS;

      const issues: string[] = [];
      if (!possibleDeployedAddress || !ethers.isAddress(possibleDeployedAddress)) {
        issues.push("Missing or invalid env: NORI_ETH_TOKEN_BRIDGE_ADDRESS");
      }
      if (!ethers.isAddress(token)) issues.push(`Invalid token address: ${token}`);
      if (issues.length) {
        logger.error("WithdrawTokenFees encountered errors:");
        issues.forEach((issue, idx) => logger.warn(`  ${idx + 1}: ${issue}`));
        logger.fatal("Due to these issues withdrawTokenFees cannot continue.");
        process.exit(1);
      }

      const [signer] = await ethers.getSigners();
      const bridge = await ethers.getContractAt("NoriTokenBridge", possibleDeployedAddress as string, signer);
      const fees = await bridge.accumulatedTokenFees(token);
      logger.log(`Fee recipient: ${await bridge.feeRecipient()}`);
      logger.log(`Accumulated fees in ${token}: ${fees} (token units)`);
      if (fees === 0n) {
        logger.log("No fees to withdraw.");
        return;
      }

      const receipt = await (await bridge.withdrawTokenFees(token)).wait();
      if (!receipt) throw new Error("No tx receipt was generated");
      logger.log(`Withdrawn in block ${receipt.blockNumber}, tx ${receipt.hash}`);
    },
  }))
  .build();
