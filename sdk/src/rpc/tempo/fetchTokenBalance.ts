import { ZeroAddress } from 'ethers';
import { FEE_MANAGER_ADDRESS, IFeeManager__factory, ITIP20__factory } from '@nori-zk/tempo-token-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { withBackoff } from '../../utils/withBackoff.js';
import { EthRpcTransportError } from '../eth/errors.js';

/**
 * Reads an account's balance of a TIP-20: nETH, an ERC-20's mirror, or a fee
 * token. TIP-20s have 6 decimals.
 *
 * @param provider The Tempo provider used for the read.
 * @param token The TIP-20.
 * @param account The account.
 * @returns The balance, in the token's units.
 * @throws EthRpcTransportError When the read still fails after its retries.
 */
export async function fetchTokenBalance(
    provider: EthereumProvider,
    token: string,
    account: string
): Promise<bigint> {
    const tip20 = ITIP20__factory.connect(token, provider);
    return withBackoff(() => tip20.balanceOf(account)).catch((error: unknown) => {
        throw new EthRpcTransportError('Failed to read the token balance.', error);
    });
}

/**
 * Reads the USD TIP-20 an account chose to pay its Tempo transaction fees
 * in, from Tempo's fee manager precompile.
 *
 * @param provider The Tempo provider used for the read.
 * @param account The account.
 * @returns The fee token, or `undefined` when the account chose none.
 * @throws EthRpcTransportError When the read still fails after its retries.
 */
export async function fetchFeeToken(provider: EthereumProvider, account: string): Promise<string | undefined> {
    const feeManager = IFeeManager__factory.connect(FEE_MANAGER_ADDRESS, provider);
    const token = await withBackoff(() => feeManager.userTokens(account)).catch((error: unknown) => {
        throw new EthRpcTransportError('Failed to read the fee token.', error);
    });
    return token === ZeroAddress ? undefined : token;
}
