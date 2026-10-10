import { map } from 'rxjs';
import { type ProofRequestConnections } from '../proofRequest/connectedRead.js';
import { changesOf$, createChainChangesMachine } from '../rpc/connection/chainChanges.impl.js';
import {
    type ReadRetryBackoff,
    startReadThroughConnectionsMachine,
} from '../rpc/connection/readThroughConnections.impl.js';
import { bridgeState$ } from '../rpc/tempo/bridgeState.js';
import { UPDATE_APPLIED_TOPIC } from '../rpc/tempo/topics.js';
import { BridgeStateGraph } from './bridgeState.js';

/**
 * Starts reading the Tempo bridge's state through the Tempo connection, and
 * reading it again each time an `update` is applied.
 *
 * @param connections The Ethereum and Tempo chains, with their running connectivity machines.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param backoff How long a failed read waits before reading again.
 * @returns The running machine; `current` carries the bridge state. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createBridgeStateMachine = (
    connections: ProofRequestConnections,
    bridgeAddress: string,
    backoff: ReadRetryBackoff = {}
) => {
    const updateApplied = createChainChangesMachine(connections.tempo, {
        address: bridgeAddress,
        topics: [UPDATE_APPLIED_TOPIC],
    });
    return startReadThroughConnectionsMachine(BridgeStateGraph, {
        connections,
        read: (clients) =>
            clients
                .tempo((provider) => bridgeState$(provider, bridgeAddress))
                .pipe(map((bridgeState) => ({ bridgeState }))),
        refreshOn: () => changesOf$(updateApplied),
        needs: ['tempo'],
        backoff,
        owns: [updateApplied],
    });
};
