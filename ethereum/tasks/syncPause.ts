import { task } from "hardhat/config";
import "../logger.js";
import { Logger } from "esm-iso-logger";

const logger = new Logger("SyncPause");

export const syncPause = task(
  "syncPause",
  "Copy an ERC-20's paused() into the bridge and request a proof of it, so its Tempo mirror follows"
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
        logger.error("SyncPause encountered errors:");
        issues.forEach((issue, idx) => logger.warn(`  ${idx + 1}: ${issue}`));
        logger.fatal("Due to these issues syncPause cannot continue.");
        process.exit(1);
      }

      const [signer] = await ethers.getSigners();
      const bridge = await ethers.getContractAt("NoriTokenBridge", possibleDeployedAddress as string, signer);
      const proofQueue = await ethers.getContractAt("NoriProofRequestQueue", await bridge.proofQueue(), signer);
      const queueFeeWei = await proofQueue.proofRequestQueueFee();

      const receipt = await (await bridge.syncPause(token, { value: queueFeeWei })).wait();
      if (!receipt) throw new Error("No tx receipt was generated");
      const synced = receipt.logs
        .map((log) => bridge.interface.parseLog(log))
        .find((parsed) => parsed?.name === "PauseSynced");
      logger.log(`Synced ${token}: paused ${synced?.args.paused}, block ${receipt.blockNumber}, tx ${receipt.hash}`);
    },
  }))
  .build();
