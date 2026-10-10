import { map, of, switchMap } from 'rxjs';
import { type ProofRequestConnections } from '../proofRequest/connectedRead.js';
import { changesOf$, createChainChangesMachine } from '../rpc/connection/chainChanges.impl.js';
import {
    type ReadRetryBackoff,
    startReadThroughConnectionsMachine,
} from '../rpc/connection/readThroughConnections.impl.js';
import { blockNumber$ } from '../rpc/evm/blockNumber.js';
import { committedProofQueueBatches$ } from '../rpc/tempo/committedProofQueueBatches.js';
import { PROOF_QUEUE_BATCH_COMMITTED_TOPIC } from '../rpc/tempo/topics.js';
import { CommittedProofQueueBatchesGraph } from './committedProofQueueBatches.js';

/**
 * Starts reading each proof queue batch the bridge commits through the
 * Tempo connection, and reading again each time it commits one. The first
 * read covers `fromBlock` to the latest block; each later read covers the
 * blocks after the last one read.
 *
 * @param connections The Ethereum and Tempo chains, with their running connectivity machines.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param fromBlock The first Tempo block to read, e.g. the bridge's deployment block (default: the latest block).
 * @param backoff How long a failed read waits before reading again.
 * @returns The running machine; `current` carries `committed`, the batches the last read found. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createCommittedProofQueueBatchesMachine = (
    connections: ProofRequestConnections,
    bridgeAddress: string,
    fromBlock?: number,
    backoff: ReadRetryBackoff = {}
) => {
    const batchCommitted = createChainChangesMachine(connections.tempo, {
        address: bridgeAddress,
        topics: [PROOF_QUEUE_BATCH_COMMITTED_TOPIC],
    });
    return startReadThroughConnectionsMachine(CommittedProofQueueBatchesGraph, {
        connections,
        read: (clients, previous) =>
            clients
                .tempo((provider) => blockNumber$(provider, 'latest'))
                .pipe(
                    switchMap((latest) => {
                        const from = previous.lastBlock === undefined ? (fromBlock ?? latest) : previous.lastBlock + 1;
                        if (from > latest) return of({ committed: [], lastBlock: from - 1 });
                        return clients
                            .tempo((provider) =>
                                committedProofQueueBatches$(provider, bridgeAddress, from, latest)
                            )
                            .pipe(map((committed) => ({ committed, lastBlock: latest })));
                    })
                ),
        refreshOn: () => changesOf$(batchCommitted),
        needs: ['tempo'],
        backoff,
        owns: [batchCommitted],
    });
};
