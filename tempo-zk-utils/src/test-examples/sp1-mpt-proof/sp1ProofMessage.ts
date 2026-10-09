import type { NoriSP1ProofInput } from '@nori-zk/pts-types';
import sp1ConsensusMPTGroth16ProofRaw from './11298112-v6.1.0.json' with { type: 'json' };

const sp1ConsensusMPTGroth16Proof = sp1ConsensusMPTGroth16ProofRaw as unknown as NoriSP1ProofInput;

export { sp1ConsensusMPTGroth16Proof };
