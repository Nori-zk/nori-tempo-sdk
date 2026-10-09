import {
    NoriTempoTokenBridge__factory,
    type NoriTempoTokenBridge,
} from '@nori-zk/tempo-token-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { isError } from 'ethers';
import { withBackoff } from '../../utils/withBackoff.js';
import { EthRpcTransportError } from '../eth/errors.js';
import { ProofQueueBatchSearchError } from './errors.js';

export interface FoundProofQueueBatch {
    proofQueueBatchIndex: bigint;
    proofQueueBatch: NoriTempoTokenBridge.ProofRequestRootEntryStructOutput;
}

/**
 * Whether a call reverted with the bridge's `NoProofQueueBatchCovers`.
 *
 * @param error The error a call threw.
 * @returns `true` for that revert.
 */
function noProofQueueBatchCovers(error: unknown): boolean {
    return isError(error, 'CALL_EXCEPTION') && error.revert?.name === 'NoProofQueueBatchCovers';
}

/**
 * Finds the committed proof queue batch whose
 * `[inputQueueCursor, outputQueueCursor)` covers `requestId`, with the
 * bridge's `findProofQueueBatch` view: a binary search over the batches'
 * cursor ranges, in one call.
 *
 * @param provider The Tempo provider used for the read.
 * @param requestId The proof request id, which must be below the bridge's queue cursor.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns The covering batch and its index.
 * @throws ProofQueueBatchSearchError When no committed batch covers `requestId`.
 * @throws EthRpcTransportError When the read still fails after its retries.
 */
export async function findProofQueueBatch(
    provider: EthereumProvider,
    requestId: bigint,
    bridgeAddress: string
): Promise<FoundProofQueueBatch> {
    const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, provider);
    const { proofQueueBatchIndex, batch } = await withBackoff(
        () => bridge.findProofQueueBatch(requestId),
        (error) => !noProofQueueBatchCovers(error)
    ).catch((error: unknown) => {
        if (noProofQueueBatchCovers(error)) {
            throw new ProofQueueBatchSearchError(
                requestId,
                `No committed proof queue batch covers request ${requestId}.`
            );
        }
        throw new EthRpcTransportError('Failed to find the proof queue batch.', error);
    });
    return { proofQueueBatchIndex, proofQueueBatch: batch };
}
