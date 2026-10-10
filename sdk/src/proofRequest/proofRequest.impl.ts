import { catchError, defer, EMPTY, filter, map, merge, type Observable, of, throwError, timer } from 'rxjs';
import { proofRequestSnapshots$ } from './proofRequestSnapshots.js';
import { type ConnectedReadClients, type ProofRequestConnections } from './connectedRead.js';
import {
    proofRequestStateSnapshot$,
    type ProofRequestStateSnapshot,
    type UndeterminedProofRequestSnapshot,
    type UnprocessedProofRequestSnapshot,
} from './getProofRequestStateSnapshot.js';
import { ProofRequestTransactionNotMinedError } from '../rpc/eth/errors.js';
import {
    type ReadRetryBackoff,
    startReadThroughConnectionsMachine,
    dueOn,
} from '../rpc/connection/readThroughConnections.impl.js';
import { withOutcome } from '../utils/machines.js';
import { ProofRequestState } from './types.js';
import { ProofRequestStateGraph, type ProofRequestStateNodeUnion } from './proofRequest.js';

/** The proof request to follow: the transaction that enqueued it, and where. */
export interface FollowedProofRequest {
    /** The Ethereum `NoriProofRequestQueue` address. */
    proofQueueAddress: string;
    /** The Ethereum transaction that enqueued the proof request. */
    proofRequestTxHash: string;
    /** The Tempo `NoriTempoTokenBridge` address. */
    bridgeAddress: string;
}

/** Where a followed proof request is: still followed (`current`), or proven (`proofAvailable`). */
type FollowedSnapshot = {
    snapshot: Extract<ProofRequestStateNodeUnion, { node: 'current' | 'proofAvailable' }>['data']['snapshot'];
};

/** A committed batch covers the request: it is proven, and not read again. */
const proven = ({ snapshot }: FollowedSnapshot) => snapshot.state === ProofRequestState.ProofAvailable;

const UNDETERMINED: UndeterminedProofRequestSnapshot = { state: ProofRequestState.Undetermined };

/**
 * Starts following one Ethereum proof request until a committed proof queue
 * batch on Tempo covers it, reading through both connections. It looks the
 * request up at once, then reads it again every `pollIntervalMs` and on
 * every `recheckTrigger$` emission until its proof is available.
 *
 * @param connections The Ethereum and Tempo chains, with their running connectivity machines.
 * @param request The transaction that enqueued the request, and the addresses.
 * @param knownSnapshot Where the request is already known to be, to resume
 *   from there (`current`, or `proofAvailable` for a proven one); it is
 *   looked up from the transaction when omitted.
 * @param pollIntervalMs The delay between reads in ms (default: 15000).
 * @param recheckTrigger$ An extra read signal, e.g. bridge state changes from the websocket.
 * @param backoff How long a failed read waits before reading again.
 * @returns The running machine; its states carry the snapshot. Its controls:
 *   - `retry()`: reads again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export function createProofRequestStateMachine(
    connections: ProofRequestConnections,
    request: FollowedProofRequest,
    knownSnapshot?: ProofRequestStateSnapshot,
    pollIntervalMs = 15_000,
    recheckTrigger$: Observable<unknown> = EMPTY,
    backoff: ReadRetryBackoff = {}
) {
    /**
     * Looks the request up from the transaction that enqueued it.
     *
     * @param clients The clients to read through.
     * @returns Its snapshot, or `undetermined` while the transaction is not mined, once.
     */
    const lookUp$ = (clients: ConnectedReadClients): Observable<FollowedSnapshot['snapshot']> =>
        proofRequestStateSnapshot$(clients, request).pipe(
            catchError((error: unknown) =>
                error instanceof ProofRequestTransactionNotMinedError ? of(UNDETERMINED) : throwError(() => error)
            )
        );

    /**
     * Reads an unprocessed request again from the bridge.
     *
     * @param clients The clients to read through.
     * @param unprocessed The request as last read.
     * @returns Its snapshot, once.
     */
    const readAgain$ = (
        clients: ConnectedReadClients,
        { requestId, requestBlockNumber }: UnprocessedProofRequestSnapshot
    ): Observable<ProofRequestStateSnapshot> =>
        clients
            .tempo((provider) =>
                defer(() =>
                    proofRequestSnapshots$(provider, [{ requestId, requestBlockNumber }], request.bridgeAddress)
                )
            )
            .pipe(map(([snapshot]) => snapshot));

    return startReadThroughConnectionsMachine(ProofRequestStateGraph, {
        connections,
        read: (clients, { snapshot }: FollowedSnapshot) =>
            (snapshot.state === ProofRequestState.Unprocessed ? readAgain$(clients, snapshot) : lookUp$(clients)).pipe(
                map((next): FollowedSnapshot => ({ snapshot: next }))
            ),
        refreshOn: () => dueOn(merge(timer(pollIntervalMs), recheckTrigger$)),
        // A read that finds the request proven moves to `proofAvailable`, not `current`.
        arrivedElsewhere: proven,
        backoff,
        ownTransitions: (read$) => ({
            proven: {
                $: () => withOutcome(read$, 'succeeded').pipe(filter(({ value }) => proven(value))),
                next: ({ value }: { value: FollowedSnapshot }) => value,
            },
        }),
        // A known snapshot resumes from there instead of looking the request up; a proven one is done.
        start:
            knownSnapshot &&
            (knownSnapshot.state === ProofRequestState.ProofAvailable
                ? { node: 'proofAvailable', data: { snapshot: knownSnapshot } }
                : { node: 'current', data: { snapshot: knownSnapshot } }),
    });
}
