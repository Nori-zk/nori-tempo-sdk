import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '../rpc/connection/readThroughConnections.js';

/**
 * The TIP-20 mirror the bridge registered for an Ethereum ERC-20, read
 * through the Tempo connection (`readThroughConnectionsOf`): read at once,
 * then again when the bridge registers the ERC-20's mirror. `mirror` is
 * `undefined` while none is registered; a registered mirror never changes,
 * so it is not read again.
 */
export const MirrorGraph = define(readThroughConnectionsOf({ mirror: undefined as string | undefined }));

/** The mirror's state: a node of the graph and its data. */
export type MirrorState = StateUnion<typeof MirrorGraph.nodes>;
