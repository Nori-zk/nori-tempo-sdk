import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '../rpc/connection/readThroughConnections.js';
import type { EnqueuedProofRequest } from '../rpc/eth/enqueuedProofRequests.js';

/**
 * One committed proof queue batch's requests, for every submitting address
 * or one: read through the Ethereum connection over the batch's own block
 * range and request id range (`readThroughConnectionsOf`). A committed batch
 * never changes, so once `current` its refresh is never due.
 */
export const ProofQueueBatchRequestsGraph = define(
    readThroughConnectionsOf({ requests: [] as EnqueuedProofRequest[] })
);

/** The batch's requests' state: a node of the graph and its data. */
export type ProofQueueBatchRequestsState = StateUnion<typeof ProofQueueBatchRequestsGraph.nodes>;
