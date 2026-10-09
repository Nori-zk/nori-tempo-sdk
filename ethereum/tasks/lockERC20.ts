import { task } from "hardhat/config";
import "../logger.js";
import { Logger } from "esm-iso-logger";

const logger = new Logger("LockERC20");

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

export const lockERC20 = task(
  "lockERC20",
  "Lock an ERC-20 for a Tempo recipient's code challenge, paying the queue fee in ETH"
)
  .addPositionalArgument({
    name: "token",
    description: "The ERC-20's address (0x-prefixed)",
  })
  .addPositionalArgument({
    name: "codeChallenge",
    description: "32-byte code challenge (0x-prefixed hex string)",
  })
  .addPositionalArgument({
    name: "amount",
    description: "Amount to lock, in whole tokens (e.g. 12.5)",
  })
  .setAction(async () => ({
    default: async ({ token, codeChallenge, amount }, hre) => {
      const { ethers } = await hre.network.getOrCreate();

      const possibleTestMode = process.env.NORI_ETH_TOKEN_BRIDGE_TEST_MODE;
      const possibleDeployedAddress = process.env.NORI_ETH_TOKEN_BRIDGE_ADDRESS;

      const issues: string[] = [];
      if (possibleTestMode !== "true") {
        issues.push(
          "NORI_ETH_TOKEN_BRIDGE_TEST_MODE must be 'true'. This facility is just for testing!"
        );
      }
      if (!possibleDeployedAddress || !ethers.isAddress(possibleDeployedAddress)) {
        issues.push("Missing or invalid env: NORI_ETH_TOKEN_BRIDGE_ADDRESS");
      }
      if (!ethers.isAddress(token)) issues.push(`Invalid token address: ${token}`);
      if (!/^0x[a-fA-F0-9]{64}$/.test(codeChallenge)) {
        issues.push("codeChallenge must be a 32-byte hex string (0x followed by 64 hex chars)");
      }
      if (issues.length) {
        logger.error("LockERC20 encountered errors:");
        issues.forEach((issue, idx) => logger.warn(`  ${idx + 1}: ${issue}`));
        logger.fatal("Due to these issues lockERC20 cannot continue.");
        process.exit(1);
      }

      const [signer] = await ethers.getSigners();
      const bridge = await ethers.getContractAt("NoriTokenBridge", possibleDeployedAddress as string, signer);
      const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
      const lockAmount = ethers.parseUnits(amount, await erc20.decimals());

      const [queueFeeWei, fee, net] = await bridge.previewLockERC20(token, lockAmount);
      logger.log(`Locking ${amount} of ${token}: fee ${fee}, net ${net} (token units), queue fee ${ethers.formatEther(queueFeeWei)} ETH`);

      await (await erc20.approve(await bridge.getAddress(), lockAmount)).wait();
      const receipt = await (await bridge.lockERC20(token, lockAmount, codeChallenge, { value: queueFeeWei })).wait();
      if (!receipt) throw new Error("No tx receipt was generated");
      logger.log(`Locked in block ${receipt.blockNumber}, tx ${receipt.hash}`);
      logger.log(`Locked so far for the code challenge (bridge units): ${await bridge.lockedERC20(token, codeChallenge)}`);
    },
  }))
  .build();
