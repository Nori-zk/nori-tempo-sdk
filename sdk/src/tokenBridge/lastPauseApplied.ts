import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '../rpc/connection/readThroughConnections.js';
import { type LastPauseApplied } from '../rpc/tempo/mirror.js';

/**
 * Which batch's pause state an ERC-20's mirror last followed, read through
 * the Tempo connection (`readThroughConnectionsOf`): read at once, then
 * again each time a pause state is applied to the ERC-20's mirror.
 * `lastPauseApplied` is `undefined` until read.
 */
export const LastPauseAppliedGraph = define(
    readThroughConnectionsOf({ lastPauseApplied: undefined as LastPauseApplied | undefined })
);

/** The last pause applied's state: a node of the graph and its data. */
export type LastPauseAppliedState = StateUnion<typeof LastPauseAppliedGraph.nodes>;
