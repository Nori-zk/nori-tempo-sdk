import { type Ethereum, forCalls, forLogs, type Tempo } from '../rpc/connection/connections.js';
import {
    type EnqueuedProofRequest,
    type EnqueuedProofRequestsQuery,
    fetchEnqueuedProofRequests as fetchEnqueuedProofRequestsFrom,
} from '../rpc/eth/fetchEnqueuedProofRequests.js';
import {
    fetchProofRequestBatch as fetchProofRequestBatchFrom,
    type ProofRequestBatchEntry,
} from '../rpc/eth/fetchProofRequestBatch.js';
import { fetchProofQueueHead as fetchProofQueueHeadFrom } from '../rpc/eth/fetchProofQueueHead.js';
import { fetchBridgeState as fetchBridgeStateFrom } from '../rpc/tempo/fetchBridgeState.js';
import { fetchProofQueueBatches as fetchProofQueueBatchesFrom } from '../rpc/tempo/fetchProofQueueBatches.js';
import {
    fetchProofQueueBatchSummaries as fetchProofQueueBatchSummariesFrom,
    type ProofQueueBatchSummary,
} from '../rpc/tempo/fetchProofQueueBatchSummaries.js';
import {
    findProofQueueBatch as findProofQueueBatchFrom,
    type FoundProofQueueBatch,
} from '../rpc/tempo/findProofQueueBatch.js';
import { findProofQueueBatchesForRequests as findProofQueueBatchesForRequestsFrom } from '../rpc/tempo/findProofQueueBatchesForRequests.js';

export { ProofQueueBatchSearchError } from '../rpc/tempo/errors.js';
export type {
    EnqueuedProofRequest,
    EnqueuedProofRequestsQuery,
    FoundProofQueueBatch,
    ProofQueueBatchSummary,
    ProofRequestBatchEntry,
};

/**
 * The queue's head: how many proof requests have ever been enqueued.
 *
 * @param ethereum The Ethereum chain.
 * @param proofQueueAddress The `NoriProofRequestQueue` address.
 * @returns The queue's head.
 */
export function getProofQueueHead(ethereum: Ethereum, proofQueueAddress: string): Promise<bigint> {
    return forCalls(ethereum, fetchProofQueueHeadFrom, proofQueueAddress);
}

/**
 * The proof requests enqueued over a block range.
 *
 * @param ethereum The Ethereum chain.
 * @param proofQueueAddress The `NoriProofRequestQueue` address.
 * @param query The block range, and optionally the submitting address and request id range.
 * @returns The requests, oldest first.
 */
export function getEnqueuedProofRequests(
    ethereum: Ethereum,
    proofQueueAddress: string,
    query: EnqueuedProofRequestsQuery
): Promise<EnqueuedProofRequest[]> {
    return forLogs(ethereum, fetchEnqueuedProofRequestsFrom, proofQueueAddress, query);
}

/**
 * Every request in one proof queue batch, as of the batch's output block.
 *
 * @param ethereum The Ethereum chain.
 * @param proofQueueAddress The `NoriProofRequestQueue` address.
 * @param inputQueueCursor Inclusive lower bound of the batch (queue request id).
 * @param outputQueueCursor Exclusive upper bound of the batch.
 * @param previousOutputBlockNumber The previous batch's output block.
 * @param outputBlockNumber The batch's output block.
 * @returns The batch's requests.
 */
export function getProofRequestBatch(
    ethereum: Ethereum,
    proofQueueAddress: string,
    inputQueueCursor: bigint,
    outputQueueCursor: bigint,
    previousOutputBlockNumber: number,
    outputBlockNumber: number
): Promise<ProofRequestBatchEntry[]> {
    return forLogs(ethereum,
        fetchProofRequestBatchFrom,
        proofQueueAddress,
        inputQueueCursor,
        outputQueueCursor,
        previousOutputBlockNumber,
        outputBlockNumber
    );
}

/**
 * The Tempo bridge's state: queue cursor, batch count, latest proven head and root.
 *
 * @param tempo The Tempo chain.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns The bridge's state.
 */
export function getBridgeState(tempo: Tempo, bridgeAddress: string) {
    return forCalls(tempo, fetchBridgeStateFrom, bridgeAddress);
}

/**
 * Proof queue batches on Tempo, by index.
 *
 * @param tempo The Tempo chain.
 * @param indices The batches' indices.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns The batches, in the order asked.
 */
export function getProofQueueBatches(tempo: Tempo, indices: bigint[], bridgeAddress: string) {
    return forCalls(tempo, fetchProofQueueBatchesFrom, indices, bridgeAddress);
}

/**
 * Proof queue batches on Tempo, by index, each with the output block of the batch before it.
 *
 * @param tempo The Tempo chain.
 * @param indices The batches' indices.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns The batch summaries, in the order asked.
 */
export function getProofQueueBatchSummaries(
    tempo: Tempo,
    indices: bigint[],
    bridgeAddress: string
): Promise<ProofQueueBatchSummary[]> {
    return forCalls(tempo, fetchProofQueueBatchSummariesFrom, indices, bridgeAddress);
}

/**
 * The proof queue batch that covers a request.
 *
 * @param tempo The Tempo chain.
 * @param requestId The request's id.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns The batch and its index.
 */
export function getProofQueueBatch(
    tempo: Tempo,
    requestId: bigint,
    bridgeAddress: string
): Promise<FoundProofQueueBatch> {
    return forCalls(tempo, findProofQueueBatchFrom, requestId, bridgeAddress);
}

/**
 * The proof queue batches that cover several requests.
 *
 * @param tempo The Tempo chain.
 * @param requestIds The requests' ids.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns Each request's batch, by request id.
 */
export function getProofQueueBatchesForRequests(
    tempo: Tempo,
    requestIds: bigint[],
    bridgeAddress: string
): Promise<Map<bigint, FoundProofQueueBatch>> {
    return forCalls(tempo, findProofQueueBatchesForRequestsFrom, requestIds, bridgeAddress);
}
