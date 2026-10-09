import { JsonRpcProvider, JsonRpcSigner } from "ethers";
import { task } from "hardhat/config";
import "../logger.js";
import { Logger } from "esm-iso-logger";

const logger = new Logger("FundFromHolder");

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

export const fundFromHolder = task(
  "fundFromHolder",
  "On a local fork only: transfer an ERC-20 from a holder, impersonated, to the signer"
)
  .addPositionalArgument({
    name: "token",
    description: "The ERC-20's address (0x-prefixed)",
  })
  .addPositionalArgument({
    name: "holder",
    description: "An account holding the token on the forked chain (0x-prefixed)",
  })
  .addPositionalArgument({
    name: "amount",
    description: "Amount to transfer, in whole tokens (e.g. 100)",
  })
  .setAction(async () => ({
    default: async ({ token, holder, amount }, hre) => {
      const { ethers } = await hre.network.getOrCreate();

      const issues: string[] = [];
      if (process.env.NORI_ETH_TOKEN_BRIDGE_TEST_MODE !== "true") {
        issues.push("NORI_ETH_TOKEN_BRIDGE_TEST_MODE must be 'true'. This facility is just for testing!");
      }
      if (!ethers.isAddress(token)) issues.push(`Invalid token address: ${token}`);
      if (!ethers.isAddress(holder)) issues.push(`Invalid holder address: ${holder}`);
      if (!process.env.ETH_RPC_URL) issues.push("Missing env: ETH_RPC_URL (the local fork node's URL)");
      if (issues.length) {
        logger.error("FundFromHolder encountered errors:");
        issues.forEach((issue, idx) => logger.warn(`  ${idx + 1}: ${issue}`));
        logger.fatal("Due to these issues fundFromHolder cannot continue.");
        process.exit(1);
      }

      const [signer] = await ethers.getSigners();
      // The holder's transfer goes straight to the local node, which sends
      // it from the impersonated holder (the node's hardhat_ cheatcodes)
      const node = new JsonRpcProvider(process.env.ETH_RPC_URL);
      await node.send("hardhat_impersonateAccount", [holder]);
      await node.send("hardhat_setBalance", [holder, ethers.toBeHex(ethers.parseEther("1"))]);
      const holderSigner = new JsonRpcSigner(node, holder);

      const erc20 = new ethers.Contract(token, ERC20_ABI, holderSigner);
      const units = ethers.parseUnits(amount, await erc20.decimals());
      await (await erc20.transfer(signer.address, units)).wait();
      await node.send("hardhat_stopImpersonatingAccount", [holder]);
      logger.log(`Signer ${signer.address} now holds ${await erc20.balanceOf(signer.address)} of ${token} (token units)`);
    },
  }))
  .build();
