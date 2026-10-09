import {
    type Ethereum,
    forCalls,
    forLogs,
    type Nori,
    type Tempo,
} from '../rpc/connection/connections.js';
import { connectedReadClientsOf } from '../proofRequest/connectedRead.js';
import { proofRequestAge as proofRequestAgeFrom } from '../rpc/eth/proofRequestAge.js';
import {
    fetchProofRequestsByTarget as fetchProofRequestsByTargetFrom,
    type ProofRequestsByTargetPage,
    type ProofRequestsByTargetQuery,
} from '../rpc/eth/fetchProofRequestsByTarget.js';
import { findRequestIdByTxHash as findRequestIdByTxHashFrom, type ProofRequest } from '../rpc/eth/fetchProofRequest.js';
import {
    fetchProofRequestCountsByTarget as fetchProofRequestCountsByTargetFrom,
    fetchProofRequestHistoryPage as fetchProofRequestHistoryPageFrom,
    type ProofRequestCounts,
    type ProofRequestHistoryAddresses,
    type ProofRequestHistoryPage,
} from '../proofRequest/fetchProofRequestHistory.js';
import {
    fetchProofRequestWitness as fetchProofRequestWitnessFrom,
    fetchVerifiedRequestWitness as fetchVerifiedRequestWitnessFrom,
    getProofRequestStateSnapshot as getProofRequestStateSnapshotFrom,
    type ProofRequestStateSnapshot,
    type ProofRequestStateSnapshotRequest,
    type VerifiedRequestWitness,
} from '../proofRequest/getProofRequestStateSnapshot.js';
import { type ProofRequestStateGraph } from '../proofRequest/proofRequest.js';
import { createUnprocessedProofRequestStateMachine as createUnprocessedProofRequestStateMachineFrom } from '../proofRequest/unprocessed.impl.js';
import { type RequestWitness } from '@nori-zk/ethereum-tempo-proof-queue-utils-glam';

// The machines.
export {
    ProofRequestStateGraph,
    type ProofRequestStateNodeUnion,
} from '../proofRequest/proofRequest.js';
export {
    createProofRequestStateMachine,
    type FollowedProofRequest,
} from '../proofRequest/proofRequest.impl.js';
export {
    ProofRequestHistoryGraph,
    type ProofRequestHistoryState,
} from '../proofRequest/proofRequestHistory.js';
export {
    createProofRequestHistoryMachine,
    type ProofRequestHistoryQuery,
    type ReadRetryBackoff,
} from '../proofRequest/proofRequestHistory.impl.js';
export {
    LatestProofRequestsGraph,
    type LatestProofRequestsState,
} from '../proofRequest/latestProofRequests.js';
export {
    createLatestProofRequestsMachine,
    type LatestProofRequestsQuery,
} from '../proofRequest/latestProofRequests.impl.js';
export {
    UnprocessedProofRequestStateGraph,
    type UnprocessedProofRequestStateNodeUnion,
} from '../proofRequest/unprocessed.js';
export { BridgeProofRequestProcessingStatus } from '../rpc/nori/proofRequest.js';
export {
    sortWaitingProofRequests,
    type NoriJob,
    type WaitingProofRequests,
} from '../proofRequest/waitingProofRequests.js';

// Types and errors.
export { ProofRequestState } from '../proofRequest/types.js';
export { ProofRequestWitnessRootMismatchError } from '../proofRequest/getProofRequestStateSnapshot.js';
export {
    MalformedProofRequestError,
    ProofRequestTransactionNotMinedError,
} from '../rpc/eth/errors.js';
export type {
    ProofRequestHistoryCursor,
    ProofRequestHistoryOrder,
} from '../rpc/eth/fetchProofRequestsByTarget.js';
export type { ProofRequestHistoryEntry } from '../proofRequest/fetchProofRequestHistory.js';
export type { RequestLeaf } from '@nori-zk/ethereum-tempo-proof-queue-utils-glam';
export type {
    ProofRequest,
    ProofRequestCounts,
    ProofRequestHistoryAddresses,
    ProofRequestHistoryPage,
    ProofRequestsByTargetPage,
    ProofRequestsByTargetQuery,
    ProofRequestStateSnapshot,
    ProofRequestStateSnapshotRequest,
    RequestWitness,
    VerifiedRequestWitness,
};

/**
 * Follows an unprocessed proof request through the bridge's stages, from Nori.
 *
 * @param proofRequestBlockNumber The block the proof request was enqueued in.
 * @param nori Nori.
 * @returns The implemented YState machine.
 */
export function createUnprocessedProofRequestStateMachine(
    proofRequestBlockNumber: number,
    nori: Nori
) {
    return createUnprocessedProofRequestStateMachineFrom(proofRequestBlockNumber, nori.websocket);
}

/**
 * Where a proof request is, read once from Ethereum and Tempo.
 *
 * @param chains The Ethereum and Tempo chains.
 * @param request The addresses and the transaction that enqueued the request.
 * @returns The unprocessed or proof available state data.
 */
export function getProofRequestStateSnapshot(
    chains: { ethereum: Ethereum; tempo: Tempo },
    request: ProofRequestStateSnapshotRequest
): Promise<ProofRequestStateSnapshot> {
    return getProofRequestStateSnapshotFrom(connectedReadClientsOf(chains), request);
}

/**
 * The witness of a proof request whose proof is available.
 *
 * @param ethereum The Ethereum chain.
 * @param proofAvailable The proof available state data.
 * @param proofQueueAddress The Ethereum `NoriProofRequestQueue` address.
 * @returns The request's leaf, its bottom-up path and the batch root.
 */
export function getProofRequestWitness(
    ethereum: Ethereum,
    proofAvailable: (typeof ProofRequestStateGraph.nodes)['proofAvailable'],
    proofQueueAddress: string
): Promise<RequestWitness> {
    return forLogs(ethereum, fetchProofRequestWitnessFrom, proofAvailable, proofQueueAddress);
}

/**
 * The witness of a proof request whose proof is available, in the shape the
 * Tempo contracts take: what `mint`, `mintERC20` and `applyPause` (and
 * `NoriRead`'s request witness) are given.
 *
 * @param ethereum The Ethereum chain.
 * @param proofAvailable The proof available state data.
 * @param proofQueueAddress The Ethereum `NoriProofRequestQueue` address.
 * @returns The request's bottom-up path, its index in the batch, and the request.
 */
export function getVerifiedRequestWitness(
    ethereum: Ethereum,
    proofAvailable: (typeof ProofRequestStateGraph.nodes)['proofAvailable'],
    proofQueueAddress: string
): Promise<VerifiedRequestWitness> {
    return forLogs(ethereum, fetchVerifiedRequestWitnessFrom, proofAvailable, proofQueueAddress);
}

/**
 * One page of a submitting address's proof requests, each with where it is now.
 *
 * @param chains The Ethereum and Tempo chains.
 * @param addresses The queue and bridge addresses.
 * @param query The submitting address, block range, order, page size and cursor.
 * @returns The page's entries, its continuation cursor, and whether the range is exhausted.
 */
export function getProofRequestHistoryPage(
    chains: { ethereum: Ethereum; tempo: Tempo },
    addresses: ProofRequestHistoryAddresses,
    query: ProofRequestsByTargetQuery
): Promise<ProofRequestHistoryPage> {
    return fetchProofRequestHistoryPageFrom(connectedReadClientsOf(chains, 'logs'), addresses, query);
}

/**
 * How many proof requests a submitting address made over a block range, and
 * how many have a proof available.
 *
 * @param chains The Ethereum and Tempo chains.
 * @param addresses The queue and bridge addresses.
 * @param query The submitting address and block range.
 * @returns The total, proven and unprocessed counts.
 */
export function getProofRequestCountsByTarget(
    chains: { ethereum: Ethereum; tempo: Tempo },
    addresses: ProofRequestHistoryAddresses,
    query: Pick<ProofRequestsByTargetQuery, 'target' | 'fromBlock' | 'toBlock' | 'maxBlockRangePerQuery'>
): Promise<ProofRequestCounts> {
    return fetchProofRequestCountsByTargetFrom(connectedReadClientsOf(chains, 'logs'), addresses, query);
}

/**
 * One page of a submitting address's proof requests.
 *
 * @param ethereum The Ethereum chain.
 * @param proofQueueAddress The `NoriProofRequestQueue` address.
 * @param query The submitting address, block range, order, page size and cursor.
 * @returns The page, its continuation cursor, and whether the range is exhausted.
 */
export function getProofRequestsByTarget(
    ethereum: Ethereum,
    proofQueueAddress: string,
    query: ProofRequestsByTargetQuery
): Promise<ProofRequestsByTargetPage> {
    return forLogs(ethereum, fetchProofRequestsByTargetFrom, proofQueueAddress, query);
}

/**
 * The proof request a transaction enqueued.
 *
 * @param ethereum The Ethereum chain.
 * @param proofQueueAddress The `NoriProofRequestQueue` address.
 * @param proofRequestTxHash The transaction that enqueued it.
 * @returns The request's id and block.
 */
export function getRequestIdByTxHash(
    ethereum: Ethereum,
    proofQueueAddress: string,
    proofRequestTxHash: string
): Promise<ProofRequest> {
    return forCalls(ethereum, findRequestIdByTxHashFrom, proofQueueAddress, proofRequestTxHash);
}

/**
 * How long ago a proof request's block was mined, in seconds.
 *
 * @param ethereum The Ethereum chain.
 * @param blockNumber The block the request was enqueued in.
 * @returns Its age in seconds.
 */
export function getProofRequestAge(ethereum: Ethereum, blockNumber: bigint): Promise<number> {
    return forCalls(ethereum, proofRequestAgeFrom, blockNumber);
}
