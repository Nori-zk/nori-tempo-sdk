import { NoriTempoTokenBridge__factory, type NoriTempoTokenBridge } from '@nori-zk/tempo-token-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { isError } from 'ethers';
import { catchError, defer, forkJoin, map, type Observable, of, throwError } from 'rxjs';
import { EvmRpcTransportError } from '../evm/errors.js';
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
 * The committed proof queue batch whose `[inputQueueCursor,
 * outputQueueCursor)` covers `requestId`, from the bridge's
 * `findProofQueueBatch` view: a binary search over the batches' cursor
 * ranges, in one call.
 *
 * @param provider The Tempo provider used for the read.
 * @param requestId The proof request id, which must be below the bridge's queue cursor.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns The covering batch and its index, once; errors with
 *   `ProofQueueBatchSearchError` when no committed batch covers `requestId`,
 *   `EvmRpcTransportError` when the read fails.
 */
export const proofQueueBatchCovering$ = (
    provider: EthereumProvider,
    requestId: bigint,
    bridgeAddress: string
): Observable<FoundProofQueueBatch> =>
    defer(() => NoriTempoTokenBridge__factory.connect(bridgeAddress, provider).findProofQueueBatch(requestId)).pipe(
        catchError((error: unknown) =>
            throwError(() =>
                noProofQueueBatchCovers(error)
                    ? new ProofQueueBatchSearchError(requestId, `No committed proof queue batch covers request ${requestId}.`)
                    : new EvmRpcTransportError('Failed to find the proof queue batch.', error)
            )
        ),
        map(({ proofQueueBatchIndex, batch }) => ({ proofQueueBatchIndex, proofQueueBatch: batch }))
    );

/**
 * The committed proof queue batch covering each of `requestIds`: one
 * `findProofQueueBatch` view call per distinct id, all at once.
 *
 * @param provider The Tempo provider used for the reads.
 * @param requestIds The proof request ids, each below the bridge's queue cursor.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns The covering batch and its index, keyed by request id, once.
 */
export const proofQueueBatchesCovering$ = (
    provider: EthereumProvider,
    requestIds: bigint[],
    bridgeAddress: string
): Observable<Map<bigint, FoundProofQueueBatch>> =>
    defer(() => {
        const unique = [...new Set(requestIds)];
        return unique.length === 0
            ? of(new Map<bigint, FoundProofQueueBatch>())
            : forkJoin(unique.map((requestId) => proofQueueBatchCovering$(provider, requestId, bridgeAddress))).pipe(
                  map((found) => new Map(unique.map((requestId, i) => [requestId, found[i]])))
              );
    });
