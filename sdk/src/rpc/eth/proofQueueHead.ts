import { NoriProofRequestQueue__factory } from '@nori-zk/ethereum-tempo-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { type Observable } from 'rxjs';
import { evmRpcRead$ } from '../evm/evmRpcRead.js';

/**
 * The queue's `head`: how many proof requests have ever been enqueued, which
 * is also the id the next request gets.
 *
 * @param provider The Ethereum provider used for the read.
 * @param proofQueueAddress The `NoriProofRequestQueue` address.
 * @returns The queue's head, once.
 */
export const proofQueueHead$ = (provider: EthereumProvider, proofQueueAddress: string): Observable<bigint> =>
    evmRpcRead$(
        () => NoriProofRequestQueue__factory.connect(proofQueueAddress, provider).head(),
        'Failed to read the proof request queue head.'
    );
