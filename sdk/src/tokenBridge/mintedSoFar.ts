import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '../rpc/connection/readThroughConnections.js';

/**
 * How much a recipient has minted so far on Tempo, of nETH or of an
 * ERC-20's mirror, read through the Tempo connection
 * (`readThroughConnectionsOf`): read at once, then again each time the
 * bridge mints to the recipient. `recipient` and `ethToken` (the ERC-20
 * whose mirror is read; `undefined` for nETH) are its starting data;
 * `minted` is `undefined` until read.
 */
export const MintedSoFarGraph = define(
    readThroughConnectionsOf({
        recipient: '',
        ethToken: undefined as string | undefined,
        minted: undefined as bigint | undefined,
    })
);

/** The minted amount's state: a node of the graph and its data. */
export type MintedSoFarState = StateUnion<typeof MintedSoFarGraph.nodes>;
