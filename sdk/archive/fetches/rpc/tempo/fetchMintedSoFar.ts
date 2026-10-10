import { NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { EthRpcTransportError } from '../eth/errors.js';

/**
 * Reads how much of the bridged token (nETH) `recipient` has minted so far,
 * in bridge units, which are the token's units.
 *
 * @param provider The Tempo provider used for the read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param recipient The Tempo address the deposits committed to.
 * @returns The amount minted so far.
 * @throws EthRpcTransportError When the read fails.
 */
export async function fetchMintedSoFar(
    provider: EthereumProvider,
    bridgeAddress: string,
    recipient: string
): Promise<bigint> {
    const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, provider);
    return bridge.mintedSoFar(recipient).catch((error: unknown) => {
        throw new EthRpcTransportError('Failed to read the minted amount.', error);
    });
}

/**
 * Reads how much of an Ethereum ERC-20's mirror `recipient` has minted so
 * far, in bridge units, which are the mirror's units.
 *
 * @param provider The Tempo provider used for the read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param ethToken The Ethereum ERC-20.
 * @param recipient The Tempo address the deposits committed to.
 * @returns The amount minted so far.
 * @throws EthRpcTransportError When the read fails.
 */
export async function fetchErc20MintedSoFar(
    provider: EthereumProvider,
    bridgeAddress: string,
    ethToken: string,
    recipient: string
): Promise<bigint> {
    const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, provider);
    return bridge.erc20MintedSoFar(ethToken, recipient).catch((error: unknown) => {
        throw new EthRpcTransportError('Failed to read the minted ERC-20 mirror amount.', error);
    });
}
