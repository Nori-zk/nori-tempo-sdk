// Local patch for @nomicfoundation/hardhat-ethers because its type
// augmentation silently fails in the TypeScript language server; see
// ethereum/hardhat-env.d.ts for the full story.
import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";

declare module "hardhat/types/network" {
  interface NetworkConnection {
    ethers: HardhatEthers;
  }
}
