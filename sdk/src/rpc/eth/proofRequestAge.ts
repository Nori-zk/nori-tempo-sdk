import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { map, type Observable } from 'rxjs';
import { EvmDataNotFoundError } from '../evm/errors.js';
import { evmRpcRead$ } from '../evm/evmRpcRead.js';

/**
 * Estimated age (milliseconds) of a proof request, based on its block number.
 *
 * @param provider The Ethereum provider used to read the block.
 * @param blockNumber The Ethereum block number that contains the proof request.
 * @returns The elapsed time between the block timestamp and the current clock,
 *   in milliseconds, once.
 */
export const proofRequestAge$ = (provider: EthereumProvider, blockNumber: bigint): Observable<number> =>
    evmRpcRead$(() => provider.getBlock(blockNumber), `Failed to read block #${blockNumber}.`).pipe(
        map((block) => {
            if (!block) throw new EvmDataNotFoundError(`Failed to fetch block #${blockNumber}.`);
            return (Math.floor(Date.now() / 1000) - block.timestamp) * 1000;
        })
    );
