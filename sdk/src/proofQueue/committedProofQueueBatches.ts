import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '../rpc/connection/readThroughConnections.js';
import { type ProofQueueBatchCommittedNotification } from '../rpc/tempo/topics.js';
import { type AsNodeData } from '../utils/machines.js';

/**
 * Each proof queue batch the bridge commits, read through the Tempo
 * connection (`readThroughConnectionsOf`) from its `ProofQueueBatchCommitted`
 * logs: read at once, then again each time the bridge commits one.
 * `committed` holds the batches committed in the blocks the last read
 * covered, oldest first, with each batch's index, root, cursors, Tempo block
 * and transaction; `lastBlock` is the last block read, and each read starts
 * after it, so every batch arrives once.
 */
export const CommittedProofQueueBatchesGraph = define(
    readThroughConnectionsOf({
        committed: [] as AsNodeData<ProofQueueBatchCommittedNotification>[],
        lastBlock: undefined as number | undefined,
    })
);

/** The committed batches' state: a node of the graph and its data. */
export type CommittedProofQueueBatchesState = StateUnion<typeof CommittedProofQueueBatchesGraph.nodes>;
