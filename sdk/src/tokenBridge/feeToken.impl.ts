import { FEE_MANAGER_ADDRESS } from '@nori-zk/tempo-token-bridge';
import { zeroPadValue } from 'ethers';
import { map } from 'rxjs';
import { type ProofRequestConnections } from '../proofRequest/connectedRead.js';
import { changesOf$, createChainChangesMachine } from '../rpc/connection/chainChanges.impl.js';
import {
    type ReadRetryBackoff,
    startReadThroughConnectionsMachine,
} from '../rpc/connection/readThroughConnections.impl.js';
import { feeToken$ } from '../rpc/tempo/tokenBalance.js';
import { USER_TOKEN_SET_TOPIC } from '../rpc/tempo/topics.js';
import { FeeTokenGraph } from './feeToken.js';

/**
 * Starts reading the fee token an account chose through the Tempo
 * connection, reading again on each `UserTokenSet` the fee manager emits
 * for the account. With a `createTokenBalanceMachine` on the fee token, it
 * tells whether the account can pay for a Tempo transaction.
 *
 * @param connections The Ethereum and Tempo chains, with their running connectivity machines.
 * @param account The account.
 * @param backoff How long a failed read waits before reading again.
 * @returns The running machine; `current` carries `feeToken`. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createFeeTokenMachine = (
    connections: ProofRequestConnections,
    account: string,
    backoff: ReadRetryBackoff = {}
) => {
    const feeTokenSet = createChainChangesMachine(connections.tempo, {
        address: FEE_MANAGER_ADDRESS,
        topics: [USER_TOKEN_SET_TOPIC, zeroPadValue(account, 32)],
    });
    return startReadThroughConnectionsMachine(FeeTokenGraph, {
        connections,
        read: (clients, held) =>
            clients
                .tempo((provider) => feeToken$(provider, held.account))
                .pipe(map((feeToken) => ({ account: held.account, feeToken }))),
        refreshOn: () => changesOf$(feeTokenSet),
        needs: ['tempo'],
        backoff,
        owns: [feeTokenSet],
        // The account is its starting data.
        start: { node: 'loading', data: { account, feeToken: undefined, failedReads: 0 } },
    });
};
