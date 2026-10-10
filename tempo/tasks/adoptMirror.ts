import { randomBytes } from "crypto";
import { task } from "hardhat/config";
import "../logger.js";
import { Logger } from "esm-iso-logger";
import {
  ISSUER_ROLE_NAME,
  PATH_USD_ADDRESS,
  PAUSE_ROLE_NAME,
  TIP20_FACTORY_ADDRESS,
  UNPAUSE_ROLE_NAME,
} from "../contracts/interfaces/ITIP20.const.js";

const logger = new Logger("AdoptMirror");

/** The roles an adopted mirror grants the bridge: minting, and following the ERC-20's pause. */
const MIRROR_ROLE_NAMES = [ISSUER_ROLE_NAME, PAUSE_ROLE_NAME, UNPAUSE_ROLE_NAME] as const;

/** The bridge's address from the environment, or exits with the problem. */
function bridgeAddressOrExit(isAddress: (value: string) => boolean, issues: string[]): string {
  const possibleBridgeAddress = process.env.NORI_TEMPO_TOKEN_BRIDGE_ADDRESS;
  if (!possibleBridgeAddress || !isAddress(possibleBridgeAddress)) {
    issues.push("Missing or invalid env: NORI_TEMPO_TOKEN_BRIDGE_ADDRESS");
  }
  if (issues.length) {
    logger.error("The task encountered errors:");
    issues.forEach((issue, idx) => logger.warn(`  ${idx + 1}: ${issue}`));
    logger.fatal("Due to these issues the task cannot continue.");
    process.exit(1);
  }
  return possibleBridgeAddress as string;
}

export const createIssuerTip20 = task(
  "createIssuerTip20",
  "The issuer's side of an adopted mirror: create a TIP-20 through TIP20Factory with the signer as its admin, and grant NoriTempoTokenBridge ISSUER_ROLE, PAUSE_ROLE and UNPAUSE_ROLE on it"
)
  .addPositionalArgument({
    name: "name",
    description: "The TIP-20's name",
  })
  .addPositionalArgument({
    name: "symbol",
    description: "The TIP-20's symbol",
  })
  .addPositionalArgument({
    name: "currency",
    description:
      'The TIP-20\'s currency, immutable: what one unit stays about 1:1 with ("USD" for a USD stablecoin; only "USD" tokens pay Tempo fees)',
  })
  .setAction(async () => ({
    default: async ({ name, symbol, currency }, hre) => {
      const { ethers } = await hre.network.getOrCreate();
      const bridgeAddress = bridgeAddressOrExit(ethers.isAddress, []);

      const [issuer] = await ethers.getSigners();
      const factory = await ethers.getContractAt("ITIP20Factory", TIP20_FACTORY_ADDRESS, issuer);
      const args = [name, symbol, currency, PATH_USD_ADDRESS, issuer.address, `0x${randomBytes(32).toString("hex")}`] as const;
      const address = await factory.createToken.staticCall(...args);
      await (await factory.createToken(...args)).wait();
      logger.log(`${symbol} created at ${address}, admin ${issuer.address}`);

      const tip20 = await ethers.getContractAt("ITIP20", address, issuer);
      for (const role of MIRROR_ROLE_NAMES) {
        await (await tip20.grantRole(ethers.id(role), bridgeAddress)).wait();
        logger.log(`Granted ${role} to NoriTempoTokenBridge ${bridgeAddress}`);
      }
      logger.log(`Next, the bridge's deployer adopts it: npm run adopt-mirror -- <ethToken> ${address}`);
    },
  }))
  .build();

export const adoptMirror = task(
  "adoptMirror",
  "Adopt an issuer's own TIP-20 as the mirror of an Ethereum ERC-20 on NoriTempoTokenBridge (the bridge's deployer only)"
)
  .addPositionalArgument({
    name: "ethToken",
    description: "The Ethereum ERC-20's address (0x-prefixed)",
  })
  .addPositionalArgument({
    name: "tip20",
    description: "The issuer's TIP-20, which granted the bridge ISSUER_ROLE, PAUSE_ROLE and UNPAUSE_ROLE (0x-prefixed)",
  })
  .setAction(async () => ({
    default: async ({ ethToken, tip20: tip20Address }, hre) => {
      const { ethers } = await hre.network.getOrCreate();
      const issues: string[] = [];
      if (!ethers.isAddress(ethToken)) issues.push(`Invalid ethToken address: ${ethToken}`);
      if (!ethers.isAddress(tip20Address)) issues.push(`Invalid tip20 address: ${tip20Address}`);
      const bridgeAddress = bridgeAddressOrExit(ethers.isAddress, issues);

      // The contract checks the same; reading first names every missing role at once
      const tip20 = await ethers.getContractAt("ITIP20", tip20Address);
      const missing: string[] = [];
      for (const role of MIRROR_ROLE_NAMES) {
        if (!(await tip20.hasRole(bridgeAddress, ethers.id(role)))) missing.push(role);
      }
      if (missing.length) {
        logger.fatal(`${tip20Address} has not granted the bridge ${missing.join(", ")}; the issuer runs createIssuerTip20 or grants them`);
        process.exit(1);
      }

      const [signer] = await ethers.getSigners();
      const bridge = await ethers.getContractAt("NoriTempoTokenBridge", bridgeAddress, signer);
      const receipt = await (await bridge.adoptMirror(ethToken, tip20Address)).wait();
      if (!receipt) throw new Error("No tx receipt was generated");
      logger.log(`Mirror of ${ethToken}: ${await bridge.mirrorOf(ethToken)} (adopted), block ${receipt.blockNumber}`);
    },
  }))
  .build();
