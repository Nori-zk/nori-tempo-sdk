import { defer, map, NEVER } from 'rxjs';
import { type ProofRequestConnections } from '../proofRequest/connectedRead.js';
import {
    type ReadRetryBackoff,
    startReadThroughConnectionsMachine,
    dueOn,
} from '../rpc/connection/readThroughConnections.impl.js';
import { enqueuedProofRequests$ } from '../rpc/eth/enqueuedProofRequests.js';
import { type ProofQueueBatchSummary } from '../rpc/tempo/proofQueueBatchSummaries.js';
import { ProofQueueBatchRequestsGraph } from './proofQueueBatchRequests.js';

export interface ProofQueueBatchRequestsQuery {
    /** Only this submitting address's requests; every address when omitted. */
    target?: string;
    /** The lowest block to read the first batch's requests from, e.g. the queue's deployment block. */
    fromBlock: number;
    /** Max blocks per log query, kept under the provider's limits. */
    maxBlockRangePerQuery?: number;
}

/**
 * Starts reading one committed batch's requests (only `query.target`'s
 * when given) over the batch's own block range and request id range,
 * through the Ethereum connection. A committed batch never changes, so they
 * are never read again.
 *
 * @param connections The Ethereum and Tempo chains, with their running connectivity machines.
 * @param proofQueueAddress The `NoriProofRequestQueue` address.
 * @param batch The batch.
 * @param query The submitting address and the lowest block.
 * @param backoff How long a failed read waits before reading again.
 * @returns The running machine; `current` carries the requests. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createProofQueueBatchRequestsMachine = (
    connections: ProofRequestConnections,
    proofQueueAddress: string,
    batch: ProofQueueBatchSummary,
    query: ProofQueueBatchRequestsQuery,
    backoff: ReadRetryBackoff = {}
) =>
    startReadThroughConnectionsMachine(ProofQueueBatchRequestsGraph, {
        connections,
        read: (clients) =>
            clients
                .ethereum((provider) =>
                    defer(() =>
                        enqueuedProofRequests$(provider, proofQueueAddress, {
                            fromBlock:
                                batch.previousOutputBlockNumber < 0n
                                    ? query.fromBlock
                                    : Number(batch.previousOutputBlockNumber) + 1,
                            toBlock: Number(batch.outputBlockNumber),
                            fromRequestId: batch.inputQueueCursor,
                            toRequestId: batch.outputQueueCursor,
                            target: query.target,
                            maxBlockRangePerQuery: query.maxBlockRangePerQuery,
                        })
                    )
                )
                .pipe(map((requests) => ({ requests }))),
        refreshOn: () => dueOn(NEVER),
        kind: 'logs',
        needs: ['ethereum'],
        backoff,
    });
