import { zeroPadValue } from 'ethers';
import { map } from 'rxjs';
import { type ProofRequestConnections } from '../proofRequest/connectedRead.js';
import { changesOf$, createChainChangesMachine } from '../rpc/connection/chainChanges.impl.js';
import {
    type ReadRetryBackoff,
    startReadThroughConnectionsMachine,
} from '../rpc/connection/readThroughConnections.impl.js';
import { erc20MintedSoFar$, mintedSoFar$ } from '../rpc/tempo/mintedSoFar.js';
import { ERC20_MINT_APPLIED_TOPIC, MINT_APPLIED_TOPIC } from '../rpc/tempo/topics.js';
import { MintedSoFarGraph } from './mintedSoFar.js';

/**
 * Starts reading how much `recipient` has minted so far through the Tempo
 * connection: nETH, or `ethToken`'s mirror when given. It reads again on
 * each `MintApplied` (or `ERC20MintApplied`) to the recipient.
 *
 * @param connections The Ethereum and Tempo chains, with their running connectivity machines.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param recipient The Tempo address the deposits committed to.
 * @param ethToken The Ethereum ERC-20 whose mirror to read; nETH when omitted.
 * @param backoff How long a failed read waits before reading again.
 * @returns The running machine; `current` carries `minted`. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export const createMintedSoFarMachine = (
    connections: ProofRequestConnections,
    bridgeAddress: string,
    recipient: string,
    ethToken?: string,
    backoff: ReadRetryBackoff = {}
) => {
    const mintApplied = createChainChangesMachine(connections.tempo, {
        address: bridgeAddress,
        topics:
            ethToken === undefined
                ? [MINT_APPLIED_TOPIC, zeroPadValue(recipient, 32)]
                : [ERC20_MINT_APPLIED_TOPIC, zeroPadValue(ethToken, 32), zeroPadValue(recipient, 32)],
    });
    return startReadThroughConnectionsMachine(MintedSoFarGraph, {
        connections,
        read: (clients, held) =>
            clients
                .tempo((provider) =>
                    held.ethToken === undefined
                        ? mintedSoFar$(provider, bridgeAddress, held.recipient)
                        : erc20MintedSoFar$(provider, bridgeAddress, held.ethToken, held.recipient)
                )
                .pipe(map((minted) => ({ recipient: held.recipient, ethToken: held.ethToken, minted }))),
        refreshOn: () => changesOf$(mintApplied),
        needs: ['tempo'],
        backoff,
        owns: [mintApplied],
        // The recipient and the ERC-20 are its starting data.
        start: { node: 'loading', data: { recipient, ethToken, minted: undefined, failedReads: 0 } },
    });
};
