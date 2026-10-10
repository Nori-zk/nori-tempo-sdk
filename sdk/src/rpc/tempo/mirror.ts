import { ZeroAddress } from 'ethers';
import { NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { map, type Observable } from 'rxjs';
import { evmRpcRead$ } from '../evm/evmRpcRead.js';

/** The batch index of the last pause state applied to a mirror, when one has been. */
export type LastPauseApplied = { applied: false } | { applied: true; proofQueueBatchIndex: bigint };

/**
 * The TIP-20 mirror the bridge registered for an Ethereum ERC-20.
 *
 * @param provider The Tempo provider used for the read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param ethToken The Ethereum ERC-20.
 * @returns The mirror's address, or `undefined` while none is registered, once.
 */
export const mirror$ = (provider: EthereumProvider, bridgeAddress: string, ethToken: string): Observable<string | undefined> =>
    evmRpcRead$(
        () => NoriTempoTokenBridge__factory.connect(bridgeAddress, provider).mirrorOf(ethToken),
        'Failed to read the ERC-20 mirror.'
    ).pipe(map((mirror) => (mirror === ZeroAddress ? undefined : mirror)));

/**
 * Which batch's pause state an ERC-20's mirror last followed. `applyPause`
 * accepts only a newer batch.
 *
 * @param provider The Tempo provider used for the read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param ethToken The Ethereum ERC-20.
 * @returns Whether a pause state was applied, and its batch index when one was, once.
 */
export const lastPauseApplied$ = (
    provider: EthereumProvider,
    bridgeAddress: string,
    ethToken: string
): Observable<LastPauseApplied> =>
    evmRpcRead$(
        () => NoriTempoTokenBridge__factory.connect(bridgeAddress, provider).lastPauseApplied(ethToken),
        'Failed to read the last applied pause state.'
    ).pipe(
        map(([applied, proofQueueBatchIndex]): LastPauseApplied =>
            applied ? { applied: true, proofQueueBatchIndex } : { applied: false }
        )
    );
