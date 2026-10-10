import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '../rpc/connection/readThroughConnections.js';

/**
 * An account's balance of a TIP-20 (nETH, an ERC-20's mirror, or a fee
 * token), read through the Tempo connection (`readThroughConnectionsOf`):
 * read at once, then again on each of the token's `Transfer` logs out of or
 * into the account, a mint included. `token` and `account` are its starting
 * data; `balance` is `undefined` until read.
 */
export const TokenBalanceGraph = define(
    readThroughConnectionsOf({ token: '', account: '', balance: undefined as bigint | undefined })
);

/** The balance's state: a node of the graph and its data. */
export type TokenBalanceState = StateUnion<typeof TokenBalanceGraph.nodes>;
