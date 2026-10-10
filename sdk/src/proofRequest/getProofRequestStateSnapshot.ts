import { ZeroHash } from 'ethers';
import { defer, map, type Observable, switchMap } from 'rxjs';
import { proofRequestSnapshots$ } from './proofRequestSnapshots.js';
import { type ConnectedReadClients } from './connectedRead.js';
import { proofRequestOfTransaction$ } from '../rpc/eth/proofRequest.js';
import { type ProofRequestBatchEntry } from '../rpc/eth/proofRequestBatch.js';
import { request_witness, type RequestWitness } from '@nori-zk/ethereum-tempo-proof-queue-utils-glam';
import { type ProofRequestState } from './types.js';

export interface ProofRequestStateSnapshotRequest {
    /** The Ethereum `NoriProofRequestQueue` address. */
    proofQueueAddress: string;
    /** The Ethereum transaction that enqueued the proof request. */
    proofRequestTxHash: string;
    /** The Tempo `NoriTempoTokenBridge` address. */
    bridgeAddress: string;
}

/** A proof request not looked up yet. */
export interface UndeterminedProofRequestSnapshot {
    state: typeof ProofRequestState.Undetermined;
}

/** A proof request the bridge has not proven yet. */
export interface UnprocessedProofRequestSnapshot {
    state: typeof ProofRequestState.Unprocessed;
    requestId: bigint;
    requestBlockNumber: bigint;
    queueCursor: bigint;
    proofQueueBatchCount: bigint;
}

/** A proof request a committed proof queue batch covers. */
export interface ProofAvailableProofRequestSnapshot {
    state: typeof ProofRequestState.ProofAvailable;
    requestId: bigint;
    requestBlockNumber: bigint;
    queueCursor: bigint;
    proofQueueBatchIndex: bigint;
    /** The Tempo block whose `update` committed the batch. */
    tempoBlockNumber: bigint;
    /** The 0x-prefixed batch root. */
    root: string;
    inputQueueCursor: bigint;
    outputQueueCursor: bigint;
    outputBlockNumber: bigint;
    /** -1 when there is no previous proof queue batch (the first-ever batch). */
    previousOutputBlockNumber: bigint;
    indexInBatch: bigint;
}

/** Where a proof request is, read from the chains. */
export type ProofRequestStateSnapshot = UnprocessedProofRequestSnapshot | ProofAvailableProofRequestSnapshot;

/**
 * Discovers where a proof request is, from Ethereum and Tempo alone.
 *
 * @param clients The runner per chain: Ethereum finds the request, Tempo classifies it.
 * @param request The addresses and the transaction that enqueued the request.
 * @returns The unprocessed or proof available snapshot, once.
 *   Errors with `ProofRequestTransactionNotMinedError` when the transaction is not mined yet,
 *   and with `ConnectionNotReadyError` when no transport of a chain could serve its part.
 */
export function proofRequestStateSnapshot$(
    clients: ConnectedReadClients,
    request: ProofRequestStateSnapshotRequest
): Observable<ProofRequestStateSnapshot> {
    return clients
        .ethereum((provider) =>
            proofRequestOfTransaction$(provider, request.proofQueueAddress, request.proofRequestTxHash)
        )
        .pipe(
            switchMap(({ requestId, blockNumber }) =>
                clients.tempo((provider) =>
                    defer(() =>
                        proofRequestSnapshots$(
                            provider,
                            [{ requestId, requestBlockNumber: BigInt(blockNumber) }],
                            request.bridgeAddress
                        )
                    )
                )
            ),
            map(([snapshot]) => snapshot)
        );
}

export class ProofRequestWitnessRootMismatchError extends Error {
    constructor(
        readonly rebuiltRoot: string,
        readonly committedRoot: string
    ) {
        super(
            `Rebuilt proof queue batch root ${rebuiltRoot} does not match the committed root ${committedRoot}.`
        );
        this.name = 'ProofRequestWitnessRootMismatchError';
    }
}

/**
 * A proven request's witness in the shape the Tempo contracts take
 * (`NoriTempoTokenBridge.VerifiedRequestWitness`, which `mint`, `mintERC20`
 * and `applyPause` take): its bottom-up path, its index in the batch, and
 * the request its leaf is hashed from, with both collection keys.
 */
export interface VerifiedRequestWitness {
    path: string[];
    index: bigint;
    value: {
        target: string;
        collectionKeysCount: number;
        collectionKeys: [string, string];
        value: bigint;
    };
}

/** A proven request's witness, as its leaf, path and root, and in the shape the Tempo contracts take. */
export interface ProofRequestWitnesses {
    witness: RequestWitness;
    verifiedWitness: VerifiedRequestWitness;
}

/**
 * Builds a proven request's witness from every request in its committed
 * batch, with `@nori-zk/ethereum-tempo-proof-queue-utils-glam` (the SP1
 * guest's own hashing, compiled to WebAssembly), checked against the batch
 * root committed on Tempo.
 *
 * @param leaves Every request in the batch, as of its output block (`proofRequestBatch$`).
 * @param proofAvailable The request's proof available snapshot.
 * @returns The request's leaf, bottom-up path and root, and the same in the shape the Tempo contracts take.
 * @throws ProofRequestWitnessRootMismatchError When the rebuilt root differs from the committed root.
 */
export function proofRequestWitnessesOf(
    leaves: ProofRequestBatchEntry[],
    proofAvailable: ProofAvailableProofRequestSnapshot
): ProofRequestWitnesses {
    const index = Number(proofAvailable.indexInBatch);
    const witness = request_witness({ leaves, index });
    if (witness.root !== proofAvailable.root.toLowerCase()) {
        throw new ProofRequestWitnessRootMismatchError(witness.root, proofAvailable.root);
    }
    const { target, collectionKeysCount, collectionKeys, value } = leaves[index];
    return {
        witness,
        verifiedWitness: {
            path: witness.path,
            index: BigInt(witness.index),
            value: {
                target,
                collectionKeysCount,
                collectionKeys: [collectionKeys[0] ?? ZeroHash, collectionKeys[1] ?? ZeroHash],
                value: BigInt(value),
            },
        },
    };
}
