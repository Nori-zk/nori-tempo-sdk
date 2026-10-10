import { zeroPadValue } from 'ethers';
import { map, NEVER } from 'rxjs';
import { type ProofRequestConnections } from '../proofRequest/connectedRead.js';
import { changesOf$, createChainChangesMachine } from '../rpc/connection/chainChanges.impl.js';
import {
    type ReadRetryBackoff,
    startReadThroughConnectionsMachine,
    dueOn,
} from '../rpc/connection/readThroughConnections.impl.js';
import { mirror$ } from '../rpc/tempo/mirror.js';
import { MIRROR_REGISTERED_TOPIC } from '../rpc/tempo/topics.js';
import { MirrorGraph } from './mirror.js';

/**
 * Starts reading the TIP-20 mirror of an Ethereum ERC-20 through the Tempo
 * connection, reading again on `MirrorRegistered` for the ERC-20 while none
 * is registered.
 *
 * @param connections The Ethereum and Tempo chains, with their running connectivity machines.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param ethToken The Ethereum ERC-20.
 * @param backoff How long a failed read waits before reading again.
 * @returns The running machine; `current` carries `mirror`. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createMirrorMachine = (
    connections: ProofRequestConnections,
    bridgeAddress: string,
    ethToken: string,
    backoff: ReadRetryBackoff = {}
) => {
    const mirrorRegistered = createChainChangesMachine(connections.tempo, {
        address: bridgeAddress,
        topics: [MIRROR_REGISTERED_TOPIC, zeroPadValue(ethToken, 32)],
    });
    return startReadThroughConnectionsMachine(MirrorGraph, {
        connections,
        read: (clients) =>
            clients
                .tempo((provider) => mirror$(provider, bridgeAddress, ethToken))
                .pipe(map((mirror) => ({ mirror }))),
        refreshOn: ({ mirror }) => (mirror === undefined ? changesOf$(mirrorRegistered) : dueOn(NEVER)),
        needs: ['tempo'],
        backoff,
        owns: [mirrorRegistered],
    });
};
