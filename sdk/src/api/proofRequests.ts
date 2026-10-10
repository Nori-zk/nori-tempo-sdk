import { type Nori } from '../rpc/connection/connections.js';
import {
    type ProofRequestsByTargetPage,
    type ProofRequestsByTargetQuery,
} from '../rpc/eth/proofRequestsByTarget.js';
import { type ProofRequest } from '../rpc/eth/proofRequest.js';
import {
    type ProofRequestCounts,
    type ProofRequestHistoryAddresses,
    type ProofRequestHistoryPage,
} from '../proofRequest/fetchProofRequestHistory.js';
import {
    type ProofAvailableProofRequestSnapshot,
    type ProofRequestStateSnapshot,
    type ProofRequestStateSnapshotRequest,
    type UndeterminedProofRequestSnapshot,
    type UnprocessedProofRequestSnapshot,
    type VerifiedRequestWitness,
} from '../proofRequest/getProofRequestStateSnapshot.js';
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
} from '../proofRequest/proofRequestHistory.impl.js';
export {
    ProofRequestWitnessGraph,
    type ProofRequestWitnessState,
} from '../proofRequest/proofRequestWitness.js';
export { createProofRequestWitnessMachine } from '../proofRequest/proofRequestWitness.impl.js';
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
} from '../rpc/eth/proofRequestsByTarget.js';
export type { ProofRequestHistoryEntry } from '../proofRequest/fetchProofRequestHistory.js';
export type { RequestLeaf } from '@nori-zk/ethereum-tempo-proof-queue-utils-glam';
export type {
    ProofAvailableProofRequestSnapshot,
    ProofRequest,
    ProofRequestCounts,
    ProofRequestHistoryAddresses,
    ProofRequestHistoryPage,
    ProofRequestsByTargetPage,
    ProofRequestsByTargetQuery,
    ProofRequestStateSnapshot,
    ProofRequestStateSnapshotRequest,
    RequestWitness,
    UndeterminedProofRequestSnapshot,
    UnprocessedProofRequestSnapshot,
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
