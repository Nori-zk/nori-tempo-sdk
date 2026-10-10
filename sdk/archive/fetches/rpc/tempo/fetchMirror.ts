import { ZeroAddress } from 'ethers';
import { NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { EthRpcTransportError } from '../eth/errors.js';

/** The batch index of the last pause state applied to a mirror, when one has been. */
export type LastPauseApplied = { applied: false } | { applied: true; proofQueueBatchIndex: bigint };

/**
 * Reads the TIP-20 mirror the bridge registered for an Ethereum ERC-20.
 *
 * @param provider The Tempo provider used for the read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param ethToken The Ethereum ERC-20.
 * @returns The mirror's address, or `undefined` while none is registered.
 * @throws EthRpcTransportError When the read fails.
 */
export async function fetchMirror(
    provider: EthereumProvider,
    bridgeAddress: string,
    ethToken: string
): Promise<string | undefined> {
    const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, provider);
    const mirror = await bridge.mirrorOf(ethToken).catch((error: unknown) => {
        throw new EthRpcTransportError('Failed to read the ERC-20 mirror.', error);
    });
    return mirror === ZeroAddress ? undefined : mirror;
}

/**
 * Reads which batch's pause state an ERC-20's mirror last followed.
 * `applyPause` accepts only a newer batch.
 *
 * @param provider The Tempo provider used for the read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param ethToken The Ethereum ERC-20.
 * @returns Whether a pause state was applied, and its batch index when one was.
 * @throws EthRpcTransportError When the read fails.
 */
export async function fetchLastPauseApplied(
    provider: EthereumProvider,
    bridgeAddress: string,
    ethToken: string
): Promise<LastPauseApplied> {
    const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, provider);
    const [applied, proofQueueBatchIndex] = await bridge.lastPauseApplied(ethToken).catch(
        (error: unknown) => {
            throw new EthRpcTransportError('Failed to read the last applied pause state.', error);
        }
    );
    return applied ? { applied: true, proofQueueBatchIndex } : { applied: false };
}
