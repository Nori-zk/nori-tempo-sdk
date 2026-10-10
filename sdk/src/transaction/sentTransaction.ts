import { type EthereumTransactionReceiptNotification } from '../rpc/eth/topics.js';
import { readThroughConnectionsOf } from '../rpc/connection/readThroughConnections.js';

/**
 * The part every transaction machine ends with: the sent transaction's
 * receipt, read through the chain's connection (`readThroughConnectionsOf`)
 * until it is mined. `receipt` is `undefined` until then; `receipt.status`
 * is 1 for success and 0 for a revert.
 *
 * @returns The nodes and edges, to spread after the machine's own.
 */
export const sentTransactionReceiptOf = () =>
    readThroughConnectionsOf({
        transactionHash: '',
        receipt: undefined as EthereumTransactionReceiptNotification | undefined,
    });
