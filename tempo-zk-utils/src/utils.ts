import { type NoriSP1ProofInput, type SP1ProofWithPublicValuesGroth16NoTee } from '@nori-zk/pts-types';

/** A `0x`-prefixed hex string. */
export type Hex = `0x${string}`;

export function uint8ArrayToBigIntBE(bytes: Uint8Array): bigint {
    return bytes.reduce((acc, byte) => (acc << 8n) + BigInt(byte), 0n);
}

export function uint8ArrayToHex(bytes: Uint8Array | number[]): Hex {
    return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

const MAX_U64 = (1n << 64n) - 1n;
function assertUint64(value: bigint): void {
    if (value < 0n || value > MAX_U64) {
        throw new RangeError(`Value out of range for u64: '${value}'.`);
    }
}

// Proof decoder

// Byte offsets of the SP1 program's public outputs, mirroring the guest's
// `ProofOutputs::to_bytes`.
const proofOffsets = {
    inputSlot: 0,
    inputStoreHash: 8,
    outputSlot: 40,
    outputStoreHash: 48,
    executionStateRoot: 80,
    verifiedRequestsRoot: 112,
    nextSyncCommitteeHash: 144,
    proofRequestQueueAddress: 176,
    inputQueueCursor: 196,
    outputQueueCursor: 204,
    outputBlockNumber: 212,
};

const proofTotalLength = 220;

/** The SP1 program's public outputs, decoded. */
export interface ConsensusMptProofOutputs {
    inputSlot: bigint;
    inputStoreHash: Hex;
    outputSlot: bigint;
    outputStoreHash: Hex;
    executionStateRoot: Hex;
    verifiedRequestsRoot: Hex;
    nextSyncCommitteeHash: Hex;
    proofRequestQueueAddress: Hex;
    inputQueueCursor: bigint;
    outputQueueCursor: bigint;
    outputBlockNumber: bigint;
}

export function decodeConsensusMptProof(ethSP1Proof: NoriSP1ProofInput): ConsensusMptProofOutputs {
    const proofData = new Uint8Array(ethSP1Proof.public_values.buffer.data);

    if (proofData.length !== proofTotalLength) {
        throw new Error(
            `Byte slice must be exactly ${proofTotalLength} bytes, got '${proofData.length}'.`
        );
    }

    const u64At = (start: number, end: number) => {
        const value = uint8ArrayToBigIntBE(proofData.slice(start, end));
        assertUint64(value);
        return value;
    };
    const hexAt = (start: number, end: number) => uint8ArrayToHex(proofData.slice(start, end));

    return {
        inputSlot: u64At(proofOffsets.inputSlot, proofOffsets.inputStoreHash),
        inputStoreHash: hexAt(proofOffsets.inputStoreHash, proofOffsets.outputSlot),
        outputSlot: u64At(proofOffsets.outputSlot, proofOffsets.outputStoreHash),
        outputStoreHash: hexAt(proofOffsets.outputStoreHash, proofOffsets.executionStateRoot),
        executionStateRoot: hexAt(proofOffsets.executionStateRoot, proofOffsets.verifiedRequestsRoot),
        verifiedRequestsRoot: hexAt(proofOffsets.verifiedRequestsRoot, proofOffsets.nextSyncCommitteeHash),
        nextSyncCommitteeHash: hexAt(proofOffsets.nextSyncCommitteeHash, proofOffsets.proofRequestQueueAddress),
        proofRequestQueueAddress: hexAt(proofOffsets.proofRequestQueueAddress, proofOffsets.inputQueueCursor),
        inputQueueCursor: u64At(proofOffsets.inputQueueCursor, proofOffsets.outputQueueCursor),
        outputQueueCursor: u64At(proofOffsets.outputQueueCursor, proofOffsets.outputBlockNumber),
        outputBlockNumber: u64At(proofOffsets.outputBlockNumber, proofTotalLength),
    };
}

/**
 * The address the proof anchors its storage witnesses on: the Ethereum
 * `NoriProofRequestQueue`.
 */
export function extractEthProofQueueAddressFromSP1Proof(ethSP1Proof: NoriSP1ProofInput): Hex {
    return decodeConsensusMptProof(ethSP1Proof).proofRequestQueueAddress;
}

function groth16Of(ethSP1Proof: NoriSP1ProofInput) {
    const proof = (ethSP1Proof as SP1ProofWithPublicValuesGroth16NoTee).proof;
    if (!('Groth16' in proof)) {
        throw new Error('Expected an SP1 Groth16 proof.');
    }
    return proof.Groth16;
}

/** The verifier selector's length: the first 4 bytes of the Groth16 vkey hash. */
const VERIFIER_SELECTOR_LENGTH = 4;

/**
 * The proof bytes the SP1 Groth16 verifier contract takes, as
 * `SP1ProofWithPublicValues::bytes()` builds them: the verifier selector,
 * then the encoded proof.
 */
export function sp1Groth16ProofBytes(ethSP1Proof: NoriSP1ProofInput): Hex {
    const { groth16_vkey_hash, encoded_proof } = groth16Of(ethSP1Proof);
    const selector = uint8ArrayToHex(Array.from(groth16_vkey_hash).slice(0, VERIFIER_SELECTOR_LENGTH));
    return `${selector}${encoded_proof}`;
}

/** The proof's public values: the 220-byte `ProofOutputs`. */
export function sp1PublicValues(ethSP1Proof: NoriSP1ProofInput): Hex {
    return uint8ArrayToHex(ethSP1Proof.public_values.buffer.data);
}

/** The SP1 program vkey the proof was made for: its first public input, as 32 bytes. */
export function sp1ProgramVkey(ethSP1Proof: NoriSP1ProofInput): Hex {
    const [programVkey] = groth16Of(ethSP1Proof).public_inputs;
    return `0x${BigInt(programVkey).toString(16).padStart(64, '0')}`;
}
