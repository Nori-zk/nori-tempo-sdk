import { NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { type EthereumLogNotification } from '../eth/topics.js';

/** The bridge contract's ABI, for its events' topics and decoding. */
const bridgeInterface = NoriTempoTokenBridge__factory.createInterface();

/** The topic of `UpdateApplied`, which every applied `update` emits. */
export const UPDATE_APPLIED_TOPIC = bridgeInterface.getEvent('UpdateApplied').topicHash;

/** The topic of `ProofQueueBatchCommitted`, which an `update` committing a non-empty batch emits. */
export const PROOF_QUEUE_BATCH_COMMITTED_TOPIC = bridgeInterface.getEvent('ProofQueueBatchCommitted').topicHash;

/** A proof queue batch committed on Tempo, from its `ProofQueueBatchCommitted` log. */
export interface ProofQueueBatchCommittedNotification {
    proofQueueBatchIndex: bigint;
    /** The batch root, 0x-prefixed. */
    root: string;
    /** The first request id the batch holds. */
    inputQueueCursor: bigint;
    /** One past the last request id the batch holds. */
    outputQueueCursor: bigint;
    /** The Ethereum block the batch's proof read the queue at. */
    outputBlockNumber: bigint;
    /** The Tempo block that committed the batch. */
    tempoBlockNumber: bigint;
    /** The `update` transaction that committed the batch. */
    transactionHash: string;
}

/**
 * A `ProofQueueBatchCommitted` log, decoded.
 *
 * @param log The log, as `logs` pushes it.
 * @returns The committed batch.
 */
export function proofQueueBatchCommittedOf(log: EthereumLogNotification): ProofQueueBatchCommittedNotification {
    const event = bridgeInterface.decodeEventLog('ProofQueueBatchCommitted', log.data, log.topics);
    return {
        proofQueueBatchIndex: event.proofQueueBatchIndex as bigint,
        root: event.root as string,
        inputQueueCursor: event.inputQueueCursor as bigint,
        outputQueueCursor: event.outputQueueCursor as bigint,
        outputBlockNumber: event.outputBlockNumber as bigint,
        tempoBlockNumber: BigInt(log.blockNumber),
        transactionHash: log.transactionHash,
    };
}

/** A transaction's receipt once it is mined, which on Tempo is final. */
export interface TempoTransactionReceiptNotification {
    transactionHash: string;
    blockNumber: bigint;
    /** 1 for success, 0 for a revert. */
    status: number | null;
}

/**
 * A transaction's receipt, once it is mined: what a receipt subscription
 * reads on each new block.
 *
 * @param provider The Tempo provider.
 * @param transactionHash The transaction.
 * @returns The receipt once mined, otherwise nothing.
 */
export async function transactionReceiptFrom(
    provider: EthereumProvider,
    transactionHash: string
): Promise<TempoTransactionReceiptNotification[]> {
    const receipt = await provider.getTransactionReceipt(transactionHash);
    if (receipt === null) return [];
    return [
        {
            transactionHash: receipt.hash,
            blockNumber: BigInt(receipt.blockNumber),
            status: receipt.status,
        },
    ];
}
