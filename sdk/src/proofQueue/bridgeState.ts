import { type NoriTempoTokenBridge } from '@nori-zk/tempo-token-bridge';
import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '../rpc/connection/readThroughConnections.js';
import { type StructFields } from '../utils/machines.js';

/**
 * The Tempo bridge's state, read through the Tempo connection
 * (`readThroughConnectionsOf`): read at once, then again each time an
 * `update` is applied (`UpdateApplied`). `bridgeState` is `undefined` until
 * the first read arrives.
 */
export const BridgeStateGraph = define(
    readThroughConnectionsOf({
        bridgeState: undefined as StructFields<NoriTempoTokenBridge.BridgeStateStructOutput> | undefined,
    })
);

/** The bridge state's state: a node of the graph and its data. */
export type BridgeStateState = StateUnion<typeof BridgeStateGraph.nodes>;
