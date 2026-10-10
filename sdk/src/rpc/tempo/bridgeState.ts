import { NoriTempoTokenBridge__factory, type NoriTempoTokenBridge } from '@nori-zk/tempo-token-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { type Observable } from 'rxjs';
import { evmRpcRead$ } from '../evm/evmRpcRead.js';

/**
 * The bridge contract's state. Tempo's finality is deterministic, so the
 * latest block's state is final.
 *
 * @param provider The Tempo provider used for the read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns The decoded bridge state, including its queue cursor and proof queue batch count, once.
 */
export const bridgeState$ = (
    provider: EthereumProvider,
    bridgeAddress: string
): Observable<NoriTempoTokenBridge.BridgeStateStructOutput> =>
    evmRpcRead$(
        () => NoriTempoTokenBridge__factory.connect(bridgeAddress, provider).state(),
        'Failed to read the bridge state.'
    );
