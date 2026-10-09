import { ZeroHash } from 'ethers';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { classifyProofRequests } from './classifyProofRequests.js';
import { type ConnectedReadClients } from './connectedRead.js';
import { findRequestIdByTxHash } from '../rpc/eth/fetchProofRequest.js';
import { fetchProofRequestBatch } from '../rpc/eth/fetchProofRequestBatch.js';
import { request_witness, type RequestWitness } from '@nori-zk/ethereum-tempo-proof-queue-utils-glam';
import type { ProofRequestStateGraph } from './proofRequest.js';

export interface ProofRequestStateSnapshotRequest {
    /** The Ethereum `NoriProofRequestQueue` address. */
    proofQueueAddress: string;
    /** The Ethereum transaction that enqueued the proof request. */
    proofRequestTxHash: string;
    /** The Tempo `NoriTempoTokenBridge` address. */
    bridgeAddress: string;
}

/**
 * Where a proof request is, read once from the chains: the data of the
 * proof request machine's `unprocessed` or `proofAvailable` node, without
 * the machine's own count of failed reads.
 */
export type ProofRequestStateSnapshot =
    | Omit<(typeof ProofRequestStateGraph.nodes)['unprocessed'], 'failedReads'>
    | (typeof ProofRequestStateGraph.nodes)['proofAvailable'];

/**
 * Discovers where a proof request is, from Ethereum and Tempo alone.
 *
 * @param clients The runner per chain: Ethereum finds the request, Tempo classifies it.
 * @param request The addresses and the transaction that enqueued the request.
 * @returns The unprocessed or proof available state data.
 * @throws ProofRequestTransactionNotMinedError When the transaction is not mined yet.
 * @throws ConnectionNotReadyError When no transport of a chain could serve its part.
 */
export async function getProofRequestStateSnapshot(
    clients: ConnectedReadClients,
    request: ProofRequestStateSnapshotRequest
): Promise<ProofRequestStateSnapshot> {
    const { requestId, blockNumber } = await clients.ethereum((provider) =>
        findRequestIdByTxHash(provider, request.proofQueueAddress, request.proofRequestTxHash)
    );
    const [snapshot] = await clients.tempo((provider) =>
        classifyProofRequests(
            provider,
            [{ requestId, requestBlockNumber: BigInt(blockNumber) }],
            request.bridgeAddress
        )
    );
    return snapshot;
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
 * Fetches every request in the proof request's committed batch from
 * Ethereum and builds its witness with `@nori-zk/ethereum-tempo-proof-queue-utils-glam` (the SP1
 * guest's own hashing, compiled to WebAssembly), checked against the batch
 * root committed on Tempo.
 *
 * @param provider The Ethereum provider.
 * @param proofAvailable The proof available state data.
 * @param proofQueueAddress The Ethereum `NoriProofRequestQueue` address.
 * @returns The request's leaf, its bottom-up path and the batch root.
 * @throws ProofRequestWitnessRootMismatchError When the rebuilt root differs from the committed root.
 */
export async function fetchProofRequestWitness(
    provider: EthereumProvider,
    proofAvailable: (typeof ProofRequestStateGraph.nodes)['proofAvailable'],
    proofQueueAddress: string
): Promise<RequestWitness> {
    const leaves = await fetchProofRequestBatch(
        provider,
        proofQueueAddress,
        proofAvailable.inputQueueCursor,
        proofAvailable.outputQueueCursor,
        Number(proofAvailable.previousOutputBlockNumber),
        Number(proofAvailable.outputBlockNumber)
    );
    const witness = request_witness({ leaves, index: Number(proofAvailable.indexInBatch) });
    if (witness.root !== proofAvailable.root.toLowerCase()) {
        throw new ProofRequestWitnessRootMismatchError(witness.root, proofAvailable.root);
    }
    return witness;
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

/**
 * Fetches every request in the proof request's committed batch from
 * Ethereum and builds its witness in the shape the Tempo contracts take,
 * checked against the batch root committed on Tempo.
 *
 * @param provider The Ethereum provider.
 * @param proofAvailable The proof available state data.
 * @param proofQueueAddress The Ethereum `NoriProofRequestQueue` address.
 * @returns The request's path, index and request.
 * @throws ProofRequestWitnessRootMismatchError When the rebuilt root differs from the committed root.
 */
export async function fetchVerifiedRequestWitness(
    provider: EthereumProvider,
    proofAvailable: (typeof ProofRequestStateGraph.nodes)['proofAvailable'],
    proofQueueAddress: string
): Promise<VerifiedRequestWitness> {
    const leaves = await fetchProofRequestBatch(
        provider,
        proofQueueAddress,
        proofAvailable.inputQueueCursor,
        proofAvailable.outputQueueCursor,
        Number(proofAvailable.previousOutputBlockNumber),
        Number(proofAvailable.outputBlockNumber)
    );
    const index = Number(proofAvailable.indexInBatch);
    const witness = request_witness({ leaves, index });
    if (witness.root !== proofAvailable.root.toLowerCase()) {
        throw new ProofRequestWitnessRootMismatchError(witness.root, proofAvailable.root);
    }
    const { target, collectionKeysCount, collectionKeys, value } = leaves[index];
    return {
        path: witness.path,
        index: BigInt(witness.index),
        value: {
            target,
            collectionKeysCount,
            collectionKeys: [collectionKeys[0] ?? ZeroHash, collectionKeys[1] ?? ZeroHash],
            value: BigInt(value),
        },
    };
}
