import { NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { type Observable } from 'rxjs';
import { evmRpcRead$ } from '../evm/evmRpcRead.js';

/**
 * How much of the bridged token (nETH) `recipient` has minted so far, in
 * bridge units, which are the token's units.
 *
 * @param provider The Tempo provider used for the read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param recipient The Tempo address the deposits committed to.
 * @returns The amount minted so far, once.
 */
export const mintedSoFar$ = (provider: EthereumProvider, bridgeAddress: string, recipient: string): Observable<bigint> =>
    evmRpcRead$(
        () => NoriTempoTokenBridge__factory.connect(bridgeAddress, provider).mintedSoFar(recipient),
        'Failed to read the minted amount.'
    );

/**
 * How much of an Ethereum ERC-20's mirror `recipient` has minted so far, in
 * bridge units, which are the mirror's units.
 *
 * @param provider The Tempo provider used for the read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param ethToken The Ethereum ERC-20.
 * @param recipient The Tempo address the deposits committed to.
 * @returns The amount minted so far, once.
 */
export const erc20MintedSoFar$ = (
    provider: EthereumProvider,
    bridgeAddress: string,
    ethToken: string,
    recipient: string
): Observable<bigint> =>
    evmRpcRead$(
        () => NoriTempoTokenBridge__factory.connect(bridgeAddress, provider).erc20MintedSoFar(ethToken, recipient),
        'Failed to read the minted ERC-20 mirror amount.'
    );
