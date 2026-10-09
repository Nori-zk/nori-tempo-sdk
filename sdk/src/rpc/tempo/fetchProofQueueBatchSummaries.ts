import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { fetchProofQueueBatches } from './fetchProofQueueBatches.js';

/** A committed proof queue batch, with where it sits among the others. */
export interface ProofQueueBatchSummary {
    proofQueueBatchIndex: bigint;
    /** The batch root, 0x-prefixed. */
    root: string;
    /** The first request id the batch holds. */
    inputQueueCursor: bigint;
    /** One past the last request id the batch holds. */
    outputQueueCursor: bigint;
    /** The Ethereum block the batch's proof read the queue at. */
    outputBlockNumber: bigint;
    /** The Tempo block whose `update` committed the batch. */
    tempoBlockNumber: bigint;
    /** The previous batch's output block; -1 for the first batch. Every request in this batch was enqueued after it. */
    previousOutputBlockNumber: bigint;
}

/**
 * Reads the proof queue batches at `proofQueueBatchIndices`, and the batch
 * before each for its output block, in one batched read.
 *
 * Every index must be below the bridge's `proofQueueBatchCount`.
 *
 * @param provider The Tempo provider used for the reads.
 * @param proofQueueBatchIndices The proof queue batch indices to read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns One summary per index, in the order given.
 * @throws EthRpcTransportError When a read still fails after its retries.
 */
export async function fetchProofQueueBatchSummaries(
    provider: EthereumProvider,
    proofQueueBatchIndices: bigint[],
    bridgeAddress: string
): Promise<ProofQueueBatchSummary[]> {
    const indices = [
        ...new Set(proofQueueBatchIndices.flatMap((index) => (index > 0n ? [index - 1n, index] : [index]))),
    ];
    const batches = await fetchProofQueueBatches(provider, indices, bridgeAddress);
    const byIndex = new Map(indices.map((index, i) => [index, batches[i]]));

    return proofQueueBatchIndices.map((index) => {
        const batch = byIndex.get(index);
        if (batch === undefined) {
            throw new RangeError(`Proof queue batch ${index} was not read.`);
        }
        return {
            proofQueueBatchIndex: index,
            root: batch.root,
            inputQueueCursor: batch.inputQueueCursor,
            outputQueueCursor: batch.outputQueueCursor,
            outputBlockNumber: batch.outputBlockNumber,
            tempoBlockNumber: batch.tempoBlockNumber,
            previousOutputBlockNumber: byIndex.get(index - 1n)?.outputBlockNumber ?? -1n,
        };
    });
}
