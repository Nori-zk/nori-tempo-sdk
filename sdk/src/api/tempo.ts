import { type NoriTempoTokenBridge } from '@nori-zk/tempo-token-bridge';

export type {
    ProofQueueBatchCommittedNotification,
    TempoTransactionReceiptNotification,
} from '../rpc/tempo/topics.js';

/** The bridge contract's whole state, as `state()` returns it. */
export type TempoBridgeState = NoriTempoTokenBridge.BridgeStateStructOutput;

// The bridge's state and a transaction's receipt, each read through the connections and kept current.
export { BridgeStateGraph, type BridgeStateState } from '../proofQueue/bridgeState.js';
export { createBridgeStateMachine } from '../proofQueue/bridgeState.impl.js';
export { TransactionReceiptGraph, type TransactionReceiptState } from '../rpc/connection/transactionReceipt.js';
export { createTransactionReceiptMachine } from '../rpc/connection/transactionReceipt.impl.js';
