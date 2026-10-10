import { type RequestWitness } from '@nori-zk/ethereum-tempo-proof-queue-utils-glam';
import { define, type StateUnion } from '@yaw-rx/ystate';
import { readThroughConnectionsOf } from '../rpc/connection/readThroughConnections.js';
import { type AsNodeData } from '../utils/machines.js';
import {
    type ProofAvailableProofRequestSnapshot,
    type VerifiedRequestWitness,
} from './getProofRequestStateSnapshot.js';

/**
 * A proven request's witness, read through the Ethereum connection
 * (`readThroughConnectionsOf`): its batch's requests, rebuilt into the
 * batch's Merkle tree and checked against the root committed on Tempo.
 * `proofAvailable` is the proven request it is made for, its starting data.
 * `witness` is the request's leaf, bottom-up path and root;
 * `verifiedWitness` is the same in the shape the Tempo contracts take
 * (`mintCall`, `mintERC20Call`, `applyPauseCall`). Both are `undefined` until read.
 * A committed batch never changes, so they are never read again.
 */
export const ProofRequestWitnessGraph = define(
    readThroughConnectionsOf({
        proofAvailable: {} as AsNodeData<ProofAvailableProofRequestSnapshot>,
        witness: undefined as RequestWitness | undefined,
        verifiedWitness: undefined as VerifiedRequestWitness | undefined,
    })
);

/** The witness's state: a node of the graph and its data. */
export type ProofRequestWitnessState = StateUnion<typeof ProofRequestWitnessGraph.nodes>;
