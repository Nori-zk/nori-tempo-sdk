import { id } from "ethers";

/** Length of the proof's public values (`NoriTempoTokenBridge.PROOF_OUTPUTS_SIZE`, nori-primitives `ProofOutputs::SIZE`). */
export const PROOF_OUTPUTS_SIZE = 220;

/** Depth of a proof queue batch's request tree (`NoriTempoTokenBridge.MAX_TREE_DEPTH`). */
export const MAX_TREE_DEPTH = 16;

/** Most requests one proof queue batch holds (`NoriTempoTokenBridge.MAX_BATCH`). */
export const MAX_BATCH = 2 ** MAX_TREE_DEPTH;

/** Most collection keys one request carries (`NoriTempoTokenBridge.MAX_COLLECTION_KEYS`). */
export const MAX_COLLECTION_KEYS = 2;

/** The first collection key of every pause state (`NoriTempoTokenBridge.PAUSE_KEY`). */
export const PAUSE_KEY = id("NORI_PAUSE_STATE");

/** A proven pause state of an unpaused ERC-20 (`NoriTempoTokenBridge.PAUSE_STATE_UNPAUSED`). */
export const PAUSE_STATE_UNPAUSED = 1n;

/** A proven pause state of a paused ERC-20 (`NoriTempoTokenBridge.PAUSE_STATE_PAUSED`). */
export const PAUSE_STATE_PAUSED = 2n;

/** The largest `uint64`, the width of the bridge's cursors, slots and amounts. */
export const MAX_U64 = (1n << 64n) - 1n;

/**
 * The bridge's storage layout (its State section), which tests and local dry
 * runs plant committed batches into: slot 2 packs
 * `latestHead | queueCursor << 64 | proofQueueBatchCount << 128`, and the
 * batch at `index` lives at `keccak256(index, 3)` (its root) and the slot
 * after (`outputBlockNumber | inputQueueCursor << 64 | outputQueueCursor << 128 | tempoBlockNumber << 192`).
 */
export const PACKED_STATE_SLOT = 2n;
export const PROOF_QUEUE_BATCHES_SLOT = 3n;

/** Bit offset of each `uint64` packed into `PACKED_STATE_SLOT`. */
export const PACKED_STATE_OFFSETS = {
    latestHead: 0n,
    queueCursor: 64n,
    proofQueueBatchCount: 128n,
} as const;

/** Bit offset of each `uint64` packed into a batch's second slot. */
export const PROOF_QUEUE_BATCH_OFFSETS = {
    outputBlockNumber: 0n,
    inputQueueCursor: 64n,
    outputQueueCursor: 128n,
    tempoBlockNumber: 192n,
} as const;
