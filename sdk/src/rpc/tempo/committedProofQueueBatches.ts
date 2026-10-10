import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { concatMap, from, map, type Observable, reduce } from 'rxjs';
import { blockRanges, MAX_BLOCK_RANGE_PER_QUERY } from '../evm/blockRanges.js';
import { evmRpcRead$ } from '../evm/evmRpcRead.js';
import { logOf } from '../eth/topics.js';
import {
    PROOF_QUEUE_BATCH_COMMITTED_TOPIC,
    proofQueueBatchCommittedOf,
    type ProofQueueBatchCommittedNotification,
} from './topics.js';

/**
 * Every proof queue batch the bridge committed in `[fromBlock, toBlock]`,
 * from its `ProofQueueBatchCommitted` logs.
 *
 * @param provider The Tempo provider used for every read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param fromBlock The first block to read.
 * @param toBlock The last block to read.
 * @returns Each committed batch, oldest first, once.
 */
export const committedProofQueueBatches$ = (
    provider: EthereumProvider,
    bridgeAddress: string,
    fromBlock: number,
    toBlock: number
): Observable<ProofQueueBatchCommittedNotification[]> =>
    from(blockRanges(fromBlock, toBlock, MAX_BLOCK_RANGE_PER_QUERY, 'asc')).pipe(
        concatMap(([chunkFrom, chunkTo]) =>
            evmRpcRead$(
                () =>
                    provider.getLogs({
                        address: bridgeAddress,
                        topics: [PROOF_QUEUE_BATCH_COMMITTED_TOPIC],
                        fromBlock: chunkFrom,
                        toBlock: chunkTo,
                    }),
                'Failed to read the committed proof queue batches.'
            ).pipe(map((logs) => logs.map((log) => proofQueueBatchCommittedOf(logOf(log)))))
        ),
        reduce((committed, chunk) => [...committed, ...chunk], [] as ProofQueueBatchCommittedNotification[])
    );
