import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '../rpc/connection/readThroughConnections.js';

/**
 * The USD TIP-20 an account chose to pay its Tempo transaction fees in,
 * read through the Tempo connection (`readThroughConnectionsOf`) from
 * Tempo's fee manager: read at once, then again each time the account
 * chooses a fee token (`UserTokenSet`).
 * `feeToken` is `undefined` until read, and while the account chose none.
 */
export const FeeTokenGraph = define(readThroughConnectionsOf({ feeToken: undefined as string | undefined }));

/** The fee token's state: a node of the graph and its data. */
export type FeeTokenState = StateUnion<typeof FeeTokenGraph.nodes>;
