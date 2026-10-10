import { id } from 'ethers';
import { NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import {
    type EthereumLogNotification,
    type EthereumTransactionReceiptNotification,
    transactionReceiptFrom,
} from '../eth/topics.js';

/** The bridge contract's ABI, for its events' topics and decoding. */
const bridgeInterface = NoriTempoTokenBridge__factory.createInterface();

/** The topic of `UpdateApplied`, which every applied `update` emits. */
export const UPDATE_APPLIED_TOPIC = bridgeInterface.getEvent('UpdateApplied').topicHash;

/** The topic of `ProofQueueBatchCommitted`, which an `update` committing a non-empty batch emits. */
export const PROOF_QUEUE_BATCH_COMMITTED_TOPIC = bridgeInterface.getEvent('ProofQueueBatchCommitted').topicHash;

/** The topic of `MintApplied`, which `mint` emits; its first indexed argument is the recipient. */
export const MINT_APPLIED_TOPIC = bridgeInterface.getEvent('MintApplied').topicHash;

/** The topic of `ERC20MintApplied`, which `mintERC20` emits; indexed by the ERC-20, then the recipient. */
export const ERC20_MINT_APPLIED_TOPIC = bridgeInterface.getEvent('ERC20MintApplied').topicHash;

/** The topic of `MirrorRegistered`, which `registerMirror` emits; indexed by the ERC-20. */
export const MIRROR_REGISTERED_TOPIC = bridgeInterface.getEvent('MirrorRegistered').topicHash;

/** The topic of `PauseApplied`, which `applyPause` emits; indexed by the ERC-20. */
export const PAUSE_APPLIED_TOPIC = bridgeInterface.getEvent('PauseApplied').topicHash;

/** The topic of a TIP-20's `Transfer`, indexed by sender then recipient; a mint is a transfer from the zero address. */
export const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');

/** The topic of the fee manager's `UserTokenSet`, emitted when an account chooses its fee token; indexed by the account, then the token. */
export const USER_TOKEN_SET_TOPIC = id('UserTokenSet(address,address)');

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
export type TempoTransactionReceiptNotification = EthereumTransactionReceiptNotification;

export { transactionReceiptFrom };
