import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '../rpc/connection/readThroughConnections.js';
import type {
    ProofAvailableProofRequestSnapshot,
    UndeterminedProofRequestSnapshot,
    UnprocessedProofRequestSnapshot,
} from './getProofRequestStateSnapshot.js';
import { ProofRequestState } from './types.js';

const { nodes, edges } = readThroughConnectionsOf({
    snapshot: { state: ProofRequestState.Undetermined } as
        | UndeterminedProofRequestSnapshot
        | UnprocessedProofRequestSnapshot,
});

/**
 * Follows one Ethereum proof request until a committed proof queue batch on
 * Tempo covers it: its snapshot, read through the connections
 * (`readThroughConnectionsOf`), until the proof is available.
 *
 * - `loading` looks the request up from the transaction that enqueued it.
 *   A transaction that is not mined yet is not a failure: the snapshot
 *   stays `undetermined`.
 * - `current` holds the snapshot while no batch covers the request. An
 *   `undetermined` one is looked up again, and an `unprocessed` one read
 *   again (`refreshing`), every poll interval or recheck signal.
 * - A read that finds a committed batch covering the request moves to
 *   `proofAvailable` (`discoveredProofAvailable` from `loading`,
 *   `proofRequestCommitted` from `refreshing`), which holds the snapshot
 *   with that batch. It is terminal: batches are append-only, so the request
 *   stays covered.
 * - `closed` is terminal too.
 */
export const ProofRequestStateGraph = define({
    nodes: {
        ...nodes,
        proofAvailable: {
            snapshot: {
                state: ProofRequestState.ProofAvailable,
                requestId: 0n,
                requestBlockNumber: 0n,
                queueCursor: 0n,
                proofQueueBatchIndex: 0n,
                tempoBlockNumber: 0n,
                root: '',
                inputQueueCursor: 0n,
                outputQueueCursor: 0n,
                outputBlockNumber: 0n,
                previousOutputBlockNumber: -1n, // sentinel: no previous proof queue batch (first-ever batch)
                indexInBatch: 0n,
            } as ProofAvailableProofRequestSnapshot,
        },
    },
    edges: {
        ...edges,
        discoveredProofAvailable: { from: 'loading', to: 'proofAvailable', on: 'proven.next' },
        proofRequestCommitted: { from: 'refreshing', to: 'proofAvailable', on: 'proven.next' },
    },
});

export type ProofRequestStateNodeUnion = StateUnion<typeof ProofRequestStateGraph.nodes>;
