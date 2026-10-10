import { type ResolveNodeData } from '@yaw-rx/ystate';
import { map, NEVER } from 'rxjs';
import {
    type ConnectedReadClients,
    type ConnectionName,
    type ProofRequestConnections,
} from '../proofRequest/connectedRead.js';
import { changesOf$, createChainChangesMachine } from '../rpc/connection/chainChanges.impl.js';
import { dueOn } from '../rpc/connection/readThroughConnections.impl.js';
import { transactionReceiptFrom } from '../rpc/eth/topics.js';
import { type sentTransactionReceiptOf } from './sentTransaction.js';

/** The sent transaction and its receipt once mined: what the receipt part's `current` holds. */
export type SentTransaction = ResolveNodeData<ReturnType<typeof sentTransactionReceiptOf>['nodes'], 'current'>;

/**
 * How a transaction machine reads its sent transaction's receipt: through
 * `chain`'s connection, and again on each new block of that chain until it
 * is mined.
 *
 * @param connections The Ethereum and Tempo chains, with their running connectivity machines.
 * @param chain The chain the transaction was sent on.
 * @returns The `read`, `refreshOn`, `needs` and `owns` of `startReadThroughConnectionsMachine`.
 */
export const sentTransactionReceiptRead = (connections: ProofRequestConnections, chain: ConnectionName) => {
    const newBlocks = createChainChangesMachine(connections[chain]);
    return {
        read: (clients: ConnectedReadClients, { transactionHash }: SentTransaction) =>
            clients[chain]((provider) => transactionReceiptFrom(provider, transactionHash)).pipe(
                map(([receipt]): SentTransaction => ({ transactionHash, receipt }))
            ),
        // A mined transaction is not read again.
        refreshOn: ({ receipt }: SentTransaction) => (receipt ? dueOn(NEVER) : changesOf$(newBlocks)),
        needs: [chain],
        owns: [newBlocks],
    };
};

