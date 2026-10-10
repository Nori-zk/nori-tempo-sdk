import { ZeroAddress } from 'ethers';
import { FEE_MANAGER_ADDRESS, IFeeManager__factory, ITIP20__factory } from '@nori-zk/tempo-token-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { map, type Observable } from 'rxjs';
import { evmRpcRead$ } from '../evm/evmRpcRead.js';

/**
 * An account's balance of a TIP-20: nETH, an ERC-20's mirror, or a fee
 * token. TIP-20s have 6 decimals.
 *
 * @param provider The Tempo provider used for the read.
 * @param token The TIP-20.
 * @param account The account.
 * @returns The balance, in the token's units, once.
 */
export const tokenBalance$ = (provider: EthereumProvider, token: string, account: string): Observable<bigint> =>
    evmRpcRead$(
        () => ITIP20__factory.connect(token, provider).balanceOf(account),
        'Failed to read the token balance.'
    );

/**
 * The USD TIP-20 an account chose to pay its Tempo transaction fees in,
 * from Tempo's fee manager precompile.
 *
 * @param provider The Tempo provider used for the read.
 * @param account The account.
 * @returns The fee token, or `undefined` when the account chose none, once.
 */
export const feeToken$ = (provider: EthereumProvider, account: string): Observable<string | undefined> =>
    evmRpcRead$(
        () => IFeeManager__factory.connect(FEE_MANAGER_ADDRESS, provider).userTokens(account),
        'Failed to read the fee token.'
    ).pipe(map((token) => (token === ZeroAddress ? undefined : token)));
