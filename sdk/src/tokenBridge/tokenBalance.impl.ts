import { zeroPadValue } from 'ethers';
import { combineLatest, map } from 'rxjs';
import { type ProofRequestConnections } from '../proofRequest/connectedRead.js';
import { changesOf$, createChainChangesMachine } from '../rpc/connection/chainChanges.impl.js';
import {
    type ReadRetryBackoff,
    startReadThroughConnectionsMachine,
} from '../rpc/connection/readThroughConnections.impl.js';
import { tokenBalance$ } from '../rpc/tempo/tokenBalance.js';
import { TRANSFER_TOPIC } from '../rpc/tempo/topics.js';
import { TokenBalanceGraph } from './tokenBalance.js';

/**
 * Starts reading an account's balance of a TIP-20 through the Tempo
 * connection, reading again on each of the token's `Transfer` logs out of
 * or into the account.
 *
 * @param connections The Ethereum and Tempo chains, with their running connectivity machines.
 * @param token The TIP-20.
 * @param account The account.
 * @param backoff How long a failed read waits before reading again.
 * @returns The running machine; `current` carries `balance`, in the token's units (6 decimals). Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createTokenBalanceMachine = (
    connections: ProofRequestConnections,
    token: string,
    account: string,
    backoff: ReadRetryBackoff = {}
) => {
    const transfersOut = createChainChangesMachine(connections.tempo, {
        address: token,
        topics: [TRANSFER_TOPIC, zeroPadValue(account, 32)],
    });
    const transfersIn = createChainChangesMachine(connections.tempo, {
        address: token,
        topics: [TRANSFER_TOPIC, null, zeroPadValue(account, 32)],
    });
    return startReadThroughConnectionsMachine(TokenBalanceGraph, {
        connections,
        read: (clients) =>
            clients
                .tempo((provider) => tokenBalance$(provider, token, account))
                .pipe(map((balance) => ({ balance }))),
        // Any transfer out of or into the account, a mint included.
        refreshOn: () => combineLatest([changesOf$(transfersOut), changesOf$(transfersIn)]),
        needs: ['tempo'],
        backoff,
        owns: [transfersOut, transfersIn],
    });
};
