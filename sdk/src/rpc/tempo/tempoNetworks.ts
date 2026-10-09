import { TEMPO_MAINNET_CHAIN_ID, TEMPO_MODERATO_CHAIN_ID } from '@nori-zk/tempo-token-bridge';

/** A public Tempo network the sdk knows the chain id and endpoints of. */
export type TempoNetwork = 'mainnet' | 'moderato';

/** A Tempo network's chain id and public http and websocket endpoints. */
export interface TempoNetworkEndpoints {
    chainId: bigint;
    rpcUrl: string;
    wssUrl: string;
}

/** Tempo's public networks: mainnet, and the Moderato testnet. */
export const PUBLIC_TEMPO_NETWORKS: Record<TempoNetwork, TempoNetworkEndpoints> = {
    mainnet: {
        chainId: TEMPO_MAINNET_CHAIN_ID,
        rpcUrl: 'https://rpc.tempo.xyz',
        wssUrl: 'wss://rpc.tempo.xyz',
    },
    moderato: {
        chainId: TEMPO_MODERATO_CHAIN_ID,
        rpcUrl: 'https://rpc.moderato.tempo.xyz',
        wssUrl: 'wss://rpc.moderato.tempo.xyz',
    },
};

/**
 * The websocket URL of an http RPC URL: the same host over ws(s), as Tempo's
 * public endpoints serve both.
 *
 * @param rpcUrl The http(s) RPC URL.
 * @returns The ws(s) URL.
 */
export const tempoWebsocketUrlOf = (rpcUrl: string): string =>
    rpcUrl.replace(/^http(s?):\/\//, 'ws$1://');
