import {
    NoriTempoTokenBridge__factory,
    type NoriTempoTokenBridge,
} from '@nori-zk/tempo-token-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { EthRpcTransportError } from '../eth/errors.js';

/**
 * Reads the bridge contract's state. Tempo's finality is deterministic, so
 * the latest block's state is final.
 *
 * @param provider The Tempo provider used for the read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns The decoded bridge state, including its queue cursor and proof queue batch count.
 * @throws EthRpcTransportError When the read fails.
 */
export async function fetchBridgeState(
    provider: EthereumProvider,
    bridgeAddress: string
): Promise<NoriTempoTokenBridge.BridgeStateStructOutput> {
    const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, provider);
    return bridge.state().catch((error: unknown) => {
        throw new EthRpcTransportError('Failed to read the bridge state.', error);
    });
}
