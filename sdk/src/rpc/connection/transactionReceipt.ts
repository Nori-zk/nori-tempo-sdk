import { define, type StateUnion } from '@yaw-rx/ystate';
import { type EthereumTransactionReceiptNotification } from '../eth/topics.js';
import { readThroughConnectionsOf } from './readThroughConnections.js';

/**
 * A transaction's receipt on one chain, read through that chain's
 * connection (`readThroughConnectionsOf`): read at once, then again on each
 * new block until the transaction is mined. `receipt` is `undefined` until
 * then; a mined receipt is never read again.
 */
export const TransactionReceiptGraph = define(
    readThroughConnectionsOf({
        receipt: undefined as EthereumTransactionReceiptNotification | undefined,
    })
);

/** The receipt's state: a node of the graph and its data. */
export type TransactionReceiptState = StateUnion<typeof TransactionReceiptGraph.nodes>;
