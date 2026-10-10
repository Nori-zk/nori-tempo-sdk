import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { findProofQueueBatch, type FoundProofQueueBatch } from './findProofQueueBatch.js';

/**
 * Finds the committed proof queue batch covering each of `requestIds`: one
 * `findProofQueueBatch` view call per distinct id, all at once.
 *
 * @param provider The Tempo provider used for the reads.
 * @param requestIds The proof request ids, each below the bridge's queue cursor.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns The covering batch and its index, keyed by request id.
 * @throws ProofQueueBatchSearchError When no committed batch covers one of the ids.
 * @throws EthRpcTransportError When a read fails.
 */
export async function findProofQueueBatchesForRequests(
    provider: EthereumProvider,
    requestIds: bigint[],
    bridgeAddress: string
): Promise<Map<bigint, FoundProofQueueBatch>> {
    const unique = [...new Set(requestIds)];
    const found = await Promise.all(
        unique.map((requestId) => findProofQueueBatch(provider, requestId, bridgeAddress))
    );
    return new Map(unique.map((requestId, i) => [requestId, found[i]]));
}
