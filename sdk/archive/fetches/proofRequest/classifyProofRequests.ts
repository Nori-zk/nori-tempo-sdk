import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { ProofQueueBatchSearchError } from '../rpc/tempo/errors.js';
import { fetchBridgeState } from '../rpc/tempo/fetchBridgeState.js';
import { fetchProofQueueBatches } from '../rpc/tempo/fetchProofQueueBatches.js';
import { findProofQueueBatchesForRequests } from '../rpc/tempo/findProofQueueBatchesForRequests.js';
import { ProofRequestState } from './types.js';
import type { ProofRequestStateSnapshot } from './getProofRequestStateSnapshot.js';

/** A proof request's queue id and the Ethereum block that enqueued it. */
export interface QueuedProofRequest {
    requestId: bigint;
    requestBlockNumber: bigint;
}

/**
 * Decides where each proof request is from one read of the bridge state:
 * ids at or beyond its queue cursor are `unprocessed`, the rest are
 * `proofAvailable` with the committed batch that covers them. Batches for
 * the proven ids are found with the bridge's `findProofQueueBatch` view, and
 * each distinct batch's predecessor is read once for its output block.
 *
 * @param provider The Tempo provider used for the reads.
 * @param queuedRequests The proof requests to classify.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns One snapshot per queued request, in the order given.
 * @throws EthRpcTransportError When a Tempo read fails.
 */
export async function classifyProofRequests(
    provider: EthereumProvider,
    queuedRequests: QueuedProofRequest[],
    bridgeAddress: string
): Promise<ProofRequestStateSnapshot[]> {
    const { queueCursor, proofQueueBatchCount } = await fetchBridgeState(provider, bridgeAddress);

    const provenIds = queuedRequests
        .filter(({ requestId }) => requestId < queueCursor)
        .map(({ requestId }) => requestId);
    const found = await findProofQueueBatchesForRequests(provider, provenIds, bridgeAddress);

    const batchIndices = [...new Set([...found.values()].map((f) => f.proofQueueBatchIndex))];
    const previousIndices = batchIndices.filter((index) => index > 0n).map((index) => index - 1n);
    const previousBatches = await fetchProofQueueBatches(provider, previousIndices, bridgeAddress);
    const previousOutputBlockNumbers = new Map(
        previousIndices.map((index, i) => [index + 1n, previousBatches[i].outputBlockNumber])
    );

    return queuedRequests.map(({ requestId, requestBlockNumber }): ProofRequestStateSnapshot => {
        if (requestId >= queueCursor) {
            return {
                state: ProofRequestState.Unprocessed,
                requestId,
                requestBlockNumber,
                queueCursor,
                proofQueueBatchCount,
            };
        }
        const covering = found.get(requestId);
        if (!covering) {
            throw new ProofQueueBatchSearchError(
                requestId,
                `No committed proof queue batch covers request ${requestId}.`
            );
        }
        const { proofQueueBatchIndex, proofQueueBatch } = covering;
        return {
            state: ProofRequestState.ProofAvailable,
            requestId,
            requestBlockNumber,
            queueCursor,
            proofQueueBatchIndex,
            tempoBlockNumber: proofQueueBatch.tempoBlockNumber,
            root: proofQueueBatch.root,
            inputQueueCursor: proofQueueBatch.inputQueueCursor,
            outputQueueCursor: proofQueueBatch.outputQueueCursor,
            outputBlockNumber: proofQueueBatch.outputBlockNumber,
            previousOutputBlockNumber:
                previousOutputBlockNumbers.get(proofQueueBatchIndex) ?? -1n, // sentinel: no previous proof queue batch (first-ever batch)
            indexInBatch: requestId - proofQueueBatch.inputQueueCursor,
        };
    });
}
