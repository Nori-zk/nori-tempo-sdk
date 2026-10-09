import { classifyProofRequests } from './classifyProofRequests.js';
import { type ConnectedReadClients } from './connectedRead.js';
import {
    type ProofRequestStateSnapshot,
    type ProofRequestStateSnapshotRequest,
} from './getProofRequestStateSnapshot.js';
import { EthRpcTransportError } from '../rpc/eth/errors.js';
import { type ProofRequest } from '../rpc/eth/fetchProofRequest.js';
import {
    fetchProofRequestsByTarget,
    type ProofRequestHistoryCursor,
    type ProofRequestsByTargetQuery,
} from '../rpc/eth/fetchProofRequestsByTarget.js';
import { fetchBridgeState } from '../rpc/tempo/fetchBridgeState.js';
import { withBackoff } from '../utils/withBackoff.js';

/** The addresses a history read needs: no single enqueuing transaction. */
export type ProofRequestHistoryRequest = Omit<
    ProofRequestStateSnapshotRequest,
    'proofRequestTxHash'
>;

/** The queue and bridge addresses a history read needs besides its clients. */
export type ProofRequestHistoryAddresses = Pick<
    ProofRequestHistoryRequest,
    'proofQueueAddress' | 'bridgeAddress'
>;

/** A request a submitting address enqueued, with where it is now. */
export interface ProofRequestHistoryEntry extends ProofRequest {
    /** `unprocessed`, or `proofAvailable` with the committed batch covering it (what `fetchProofRequestWitness` takes). */
    snapshot: ProofRequestStateSnapshot;
}

export interface ProofRequestHistoryPage {
    entries: ProofRequestHistoryEntry[];
    /** Pass as `after` for the next page. */
    cursor?: ProofRequestHistoryCursor;
    /** Whether the scan reached the end of the block range. */
    done: boolean;
}

export interface ProofRequestCounts {
    total: number;
    proofAvailable: number;
    unprocessed: number;
}

/** Requests read per log page while counting; counting keeps no entries, only ids. */
const COUNTING_PAGE_SIZE = 1000;

/**
 * Reads one page of a submitting address's proof requests from Ethereum and
 * classifies them against one read of the bridge state on Tempo.
 *
 * @param clients The runner per chain: Ethereum reads the page, Tempo classifies it.
 * @param request The queue and bridge addresses.
 * @param query The submitting address, block range, order, page size and cursor.
 * @returns The page's entries, its continuation cursor, and whether the range is exhausted.
 * @throws ConnectionNotReadyError When no transport of a chain could serve its part.
 */
export async function fetchProofRequestHistoryPage(
    clients: ConnectedReadClients,
    request: ProofRequestHistoryRequest,
    query: ProofRequestsByTargetQuery
): Promise<ProofRequestHistoryPage> {
    const page = await clients.ethereum((provider) =>
        fetchProofRequestsByTarget(provider, request.proofQueueAddress, query)
    );
    if (page.requests.length === 0) {
        return { entries: [], cursor: page.cursor, done: page.done };
    }
    const snapshots = await clients.tempo((provider) =>
        classifyProofRequests(
            provider,
            page.requests.map((proofRequest) => ({
                requestId: proofRequest.requestId,
                requestBlockNumber: BigInt(proofRequest.blockNumber),
            })),
            request.bridgeAddress
        )
    );
    return {
        entries: page.requests.map((proofRequest, i) => ({
            ...proofRequest,
            snapshot: snapshots[i],
        })),
        cursor: page.cursor,
        done: page.done,
    };
}

/**
 * Counts a submitting address's proof requests over a block range, and how
 * many have a proof available: the queue drains in order, so every id below
 * the bridge's queue cursor is proven.
 *
 * @param clients The runner per chain: Ethereum reads the requests, Tempo the bridge's queue cursor.
 * @param request The queue and bridge addresses.
 * @param query The submitting address and block range.
 * @returns The total, proven and unprocessed counts.
 * @throws ConnectionNotReadyError When no transport of a chain could serve its part.
 */
export async function fetchProofRequestCountsByTarget(
    clients: ConnectedReadClients,
    request: ProofRequestHistoryRequest,
    query: Pick<
        ProofRequestsByTargetQuery,
        'target' | 'fromBlock' | 'toBlock' | 'maxBlockRangePerQuery'
    >
): Promise<ProofRequestCounts> {
    // Fixed up front so every page reads the same range.
    const toBlock =
        query.toBlock ??
        (await clients.ethereum((provider) =>
            withBackoff(() => provider.getBlockNumber()).catch((error: unknown) => {
                throw new EthRpcTransportError('Failed to read the latest block number.', error);
            })
        ));

    const requestIds: bigint[] = [];
    let after: ProofRequestHistoryCursor | undefined;
    for (;;) {
        const page = await clients.ethereum((provider) =>
            fetchProofRequestsByTarget(provider, request.proofQueueAddress, {
                ...query,
                toBlock,
                order: 'asc',
                pageSize: COUNTING_PAGE_SIZE,
                after,
            })
        );
        requestIds.push(
            ...page.requests.map((proofRequest) => proofRequest.requestId)
        );
        after = page.cursor;
        if (page.done) break;
    }

    const { queueCursor } = await clients.tempo((provider) =>
        fetchBridgeState(provider, request.bridgeAddress)
    );
    const proofAvailable = requestIds.filter(
        (requestId) => requestId < queueCursor
    ).length;
    return {
        total: requestIds.length,
        proofAvailable,
        unprocessed: requestIds.length - proofAvailable,
    };
}
