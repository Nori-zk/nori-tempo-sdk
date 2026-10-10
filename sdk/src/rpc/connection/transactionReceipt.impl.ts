import { map, NEVER } from 'rxjs';
import { type ConnectionName, type ProofRequestConnections } from '../../proofRequest/connectedRead.js';
import { transactionReceiptFrom } from '../eth/topics.js';
import { changesOf$, createChainChangesMachine } from './chainChanges.impl.js';
import { type ReadRetryBackoff, startReadThroughConnectionsMachine, dueOn } from './readThroughConnections.impl.js';
import { TransactionReceiptGraph } from './transactionReceipt.js';

/**
 * Starts reading a transaction's receipt through one chain's connection,
 * and reading it again on each new block of that chain until it is mined.
 *
 * @param connections The Ethereum and Tempo chains, with their running connectivity machines.
 * @param chain The chain the transaction was sent on.
 * @param transactionHash The transaction.
 * @param backoff How long a failed read waits before reading again.
 * @returns The running machine; `current` carries the receipt once mined. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createTransactionReceiptMachine = (
    connections: ProofRequestConnections,
    chain: ConnectionName,
    transactionHash: string,
    backoff: ReadRetryBackoff = {}
) => {
    const newBlocks = createChainChangesMachine(connections[chain]);
    return startReadThroughConnectionsMachine(TransactionReceiptGraph, {
        connections,
        read: (clients) =>
            clients[chain]((provider) => transactionReceiptFrom(provider, transactionHash)).pipe(
                map(([receipt]) => ({ receipt }))
            ),
        refreshOn: ({ receipt }) => (receipt ? dueOn(NEVER) : changesOf$(newBlocks)),
        needs: [chain],
        backoff,
        owns: [newBlocks],
    });
};
