import noriTempoTokenBridgeRaw from './artifacts/contracts/NoriTempoTokenBridge.sol/NoriTempoTokenBridge.json' with { type: "json" };
import sp1VerifierRaw from './artifacts/lib/sp1-contracts/contracts/src/v6.1.0/SP1VerifierGroth16.sol/SP1Verifier.json' with { type: "json" };

export interface Artifact {
  _format: string;
  contractName: string;
  sourceName: string;
  abi: Array<{
    inputs: Array<{
      internalType: string;
      name: string;
      type: string;
      indexed?: boolean;
    }>;
    name?: string;
    outputs?: Array<{
      internalType: string;
      name: string;
      type: string;
    }>;
    stateMutability?: string;
    type: string;
    anonymous?: boolean;
  }>;
  bytecode: string;
  deployedBytecode: string;
  linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>>;
  deployedLinkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>>;
}

export const noriTempoTokenBridgeJson: Artifact = noriTempoTokenBridgeRaw as Artifact;
export const sp1VerifierJson: Artifact = sp1VerifierRaw as Artifact;

export * from './contracts/NoriTempoTokenBridge.const.js';
export * from './contracts/interfaces/ITIP20.const.js';
export * from './contracts/interfaces/IFeeManager.const.js';
export * from './tempoNetworks.const.js';
export * from './types/ethers-contracts/index.js';
