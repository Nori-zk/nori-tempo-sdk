import { zeroPadValue } from 'ethers';
import { map } from 'rxjs';
import { type ProofRequestConnections } from '../proofRequest/connectedRead.js';
import { changesOf$, createChainChangesMachine } from '../rpc/connection/chainChanges.impl.js';
import {
    type ReadRetryBackoff,
    startReadThroughConnectionsMachine,
} from '../rpc/connection/readThroughConnections.impl.js';
import { lastPauseApplied$ } from '../rpc/tempo/mirror.js';
import { PAUSE_APPLIED_TOPIC } from '../rpc/tempo/topics.js';
import { LastPauseAppliedGraph } from './lastPauseApplied.js';

/**
 * Starts reading which batch's pause state an ERC-20's mirror last followed
 * through the Tempo connection, reading again on each `PauseApplied` for
 * the ERC-20. `applyPause` accepts only a newer batch.
 *
 * @param connections The Ethereum and Tempo chains, with their running connectivity machines.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param ethToken The Ethereum ERC-20.
 * @param backoff How long a failed read waits before reading again.
 * @returns The running machine; `current` carries `lastPauseApplied`. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createLastPauseAppliedMachine = (
    connections: ProofRequestConnections,
    bridgeAddress: string,
    ethToken: string,
    backoff: ReadRetryBackoff = {}
) => {
    const pauseApplied = createChainChangesMachine(connections.tempo, {
        address: bridgeAddress,
        topics: [PAUSE_APPLIED_TOPIC, zeroPadValue(ethToken, 32)],
    });
    return startReadThroughConnectionsMachine(LastPauseAppliedGraph, {
        connections,
        read: (clients, held) =>
            clients
                .tempo((provider) => lastPauseApplied$(provider, bridgeAddress, held.ethToken))
                .pipe(map((lastPauseApplied) => ({ ethToken: held.ethToken, lastPauseApplied }))),
        refreshOn: () => changesOf$(pauseApplied),
        needs: ['tempo'],
        backoff,
        owns: [pauseApplied],
        // The ERC-20 is its starting data.
        start: { node: 'loading', data: { ethToken, lastPauseApplied: undefined, failedReads: 0 } },
    });
};
