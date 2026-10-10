import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { map, type Observable } from 'rxjs';
import { EvmDataNotFoundError } from './errors.js';
import { evmRpcRead$ } from './evmRpcRead.js';

/**
 * The number of the block `tag` names: the latest, or the latest finalized.
 * The bridge proves only finalized state, so a request in a later block
 * waits for finality before any proof can cover it.
 *
 * @param provider The provider read through.
 * @param tag `latest` or `finalized`.
 * @returns The block's number, once; errors with `EvmRpcTransportError` when
 *   the read fails, `EvmDataNotFoundError` when the node has no such block.
 */
export const blockNumber$ = (provider: EthereumProvider, tag: 'latest' | 'finalized'): Observable<number> =>
    evmRpcRead$(() => provider.getBlock(tag), `Failed to read the ${tag} block.`).pipe(
        map((block) => {
            if (block === null) throw new EvmDataNotFoundError(`The node has no ${tag} block.`);
            return block.number;
        })
    );
