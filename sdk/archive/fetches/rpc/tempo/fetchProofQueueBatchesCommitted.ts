import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { blockRanges, MAX_BLOCK_RANGE_PER_QUERY } from '../eth/blockRanges.js';
import { EthRpcTransportError } from '../eth/errors.js';
import { logOf } from '../eth/topics.js';
import {
    PROOF_QUEUE_BATCH_COMMITTED_TOPIC,
    proofQueueBatchCommittedOf,
    type ProofQueueBatchCommittedNotification,
} from './topics.js';

/**
 * Reads every proof queue batch the bridge committed in `[fromBlock,
 * toBlock]`, from its `ProofQueueBatchCommitted` logs.
 *
 * @param provider The Tempo provider used for every read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param fromBlock The first block to read.
 * @param toBlock The last block to read.
 * @returns Each committed batch, oldest first.
 * @throws EthRpcTransportError When a read fails.
 */
export async function fetchProofQueueBatchesCommitted(
    provider: EthereumProvider,
    bridgeAddress: string,
    fromBlock: number,
    toBlock: number
): Promise<ProofQueueBatchCommittedNotification[]> {
    const committed: ProofQueueBatchCommittedNotification[] = [];
    for (const [chunkFrom, chunkTo] of blockRanges(fromBlock, toBlock, MAX_BLOCK_RANGE_PER_QUERY, 'asc')) {
        const logs = await provider
            .getLogs({
                address: bridgeAddress,
                topics: [PROOF_QUEUE_BATCH_COMMITTED_TOPIC],
                fromBlock: chunkFrom,
                toBlock: chunkTo,
            })
            .catch((error: unknown) => {
                throw new EthRpcTransportError('Failed to read the committed proof queue batches.', error);
            });
        committed.push(...logs.map((log) => proofQueueBatchCommittedOf(logOf(log))));
    }
    return committed;
}
