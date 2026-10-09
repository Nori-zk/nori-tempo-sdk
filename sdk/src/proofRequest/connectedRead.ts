import {
    catchError,
    combineLatest,
    defer,
    distinctUntilChanged,
    filter,
    from,
    map,
    merge,
    type Observable,
    of,
    skip,
    Subject,
    switchMap,
    take,
    takeUntil,
} from 'rxjs';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { messageOf } from '../utils/messageOf.js';
import { ConnectionNotReadyError, type TransportState } from '../rpc/connection/connectionNotReady.js';
import {
    type Ethereum,
    ethereumCallsUsable$,
    forCalls,
    forLogs,
    type Tempo,
} from '../rpc/connection/connections.js';

/**
 * The Ethereum and Tempo chains a reading machine reads through. The
 * reading machines are coupled to the transports' machines through their
 * running instances' `state$`, as the heater and the room are coupled
 * through shared streams, not through graph `deps`: a graph's deps must be
 * implemented at definition time, and each transport's machine is
 * implemented per instance around its own endpoints.
 */
export interface ProofRequestConnections {
    ethereum: Ethereum;
    tempo: Tempo;
}

/** Which of the two chains. */
export type ConnectionName = keyof ProofRequestConnections;

/** Runs one read on a chain, through the transports of its order. */
export type ChainRead = <T>(read: (provider: EthereumProvider) => Promise<T>) => Promise<T>;

/**
 * What one read goes through: a runner per chain. Each runs its part of the
 * read on the first ready transport in that chain's order and moves on to
 * the next when one fails to reach its node, so a failure is told to the
 * transport of the chain it happened on.
 */
export interface ConnectedReadClients {
    ethereum: ChainRead;
    tempo: ChainRead;
}

/** How one read through both chains ended. */
export type ConnectedRead<T> =
    | { outcome: 'succeeded'; value: T }
    | { outcome: 'connectionLost'; waitingOn: ConnectionName[] }
    | { outcome: 'failedOnHealthyConnection'; error: string }
    | { outcome: 'failed'; error: string };

/**
 * The runners a read through both chains goes through: Ethereum in its
 * calls or logs order, Tempo in its calls order.
 *
 * @param connections The two chains.
 * @param kind Whether Ethereum's calls or logs order applies.
 * @returns The runner per chain.
 */
export function connectedReadClientsOf(
    connections: ProofRequestConnections,
    kind: 'calls' | 'logs' = 'calls'
): ConnectedReadClients {
    const through = kind === 'logs' ? forLogs : forCalls;
    return {
        ethereum: (read) => through(connections.ethereum, read),
        tempo: (read) => forCalls(connections.tempo, read),
    };
}

/**
 * The chains that cannot serve a read, each time either changes: each while
 * no transport in its calls order is usable.
 *
 * @param connections The two chains.
 * @param whileChecking Count a transport re-checking itself as able: what a
 *   failed request did is decided once its check settles.
 * @returns The names of the chains that cannot serve a read, in a fixed order.
 */
function notReady$(
    connections: ProofRequestConnections,
    whileChecking = false
): Observable<ConnectionName[]> {
    return combineLatest([
        ethereumCallsUsable$(connections.ethereum, whileChecking),
        ethereumCallsUsable$(connections.tempo, whileChecking),
    ]).pipe(
        map(([ethereumUsable, tempoUsable]) => {
            const names: ConnectionName[] = [];
            if (!ethereumUsable) names.push('ethereum');
            if (!tempoUsable) names.push('tempo');
            return names;
        })
    );
}

/**
 * Whether two lists of connection names are the same.
 *
 * @param a A list of names.
 * @param b Another list of names.
 * @returns `true` when they hold the same names in the same order.
 */
function sameNames(a: ConnectionName[], b: ConnectionName[]): boolean {
    return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * Emits once both chains can serve a read: at once if they already can.
 *
 * @param connections The two chains.
 * @returns A single emission when both are ready.
 */
export function bothReady$(
    connections: ProofRequestConnections
): Observable<void> {
    return notReady$(connections).pipe(
        filter((names) => names.length === 0),
        take(1),
        map((): void => undefined)
    );
}

/**
 * The chains a waiting machine waits on, each time the set changes while
 * some still cannot serve a read. The set the machine entered with is not
 * repeated: the first emission, the set as it stands when subscribed, is
 * skipped.
 *
 * @param connections The two chains.
 * @returns The names of the chains that cannot serve a read, when that set changes.
 */
export function waitingOnChanged$(
    connections: ProofRequestConnections
): Observable<ConnectionName[]> {
    return notReady$(connections).pipe(
        distinctUntilChanged(sameNames),
        skip(1),
        filter((names) => names.length > 0)
    );
}

/**
 * The machine of a transport, by its name.
 *
 * @param connections The two chains.
 * @param transport The transport's name.
 * @returns Its machine, or `undefined` when it is not configured.
 */
function machineOf(
    connections: ProofRequestConnections,
    { transport }: TransportState
): { state$: Observable<{ node: string }> } | undefined {
    const [chainName, kind] = transport.split('.') as [string, 'http' | 'websocket' | 'wallet'];
    if (chainName !== 'ethereum' && chainName !== 'tempo') return undefined;
    return connections[chainName][kind].connection as { state$: Observable<{ node: string }> } | undefined;
}

/**
 * Decides what it was when every transport tried on a chain failed to reach
 * its node, once those transports (each already told) have re-checked
 * themselves: both chains usable again means the read itself failed;
 * otherwise the connection was lost.
 *
 * @param connections The two chains.
 * @param error The failure, listing the transports that got no response.
 * @returns The outcome, once they have settled.
 */
function outcomeAfterRecheck$(
    connections: ProofRequestConnections,
    error: ConnectionNotReadyError
): Observable<ConnectedRead<never>> {
    const machines = error.notReady
        .filter(({ state }) => state.node === 'noResponse')
        .map((transportState) => machineOf(connections, transportState))
        .filter((machine): machine is NonNullable<typeof machine> => machine !== undefined)
        .map((machine) =>
            machine.state$.pipe(
                filter(({ node }) => node !== 'checking'),
                take(1)
            )
        );
    return combineLatest(machines).pipe(
        take(1),
        switchMap(() => notReady$(connections).pipe(take(1))),
        switchMap((waitingOn) =>
            waitingOn.length === 0
                ? of({
                      outcome: 'failedOnHealthyConnection' as const,
                      error: messageOf(error),
                  })
                : of({ outcome: 'connectionLost' as const, waitingOn })
        )
    );
}

/**
 * Runs one read through both chains and reports how it ended:
 *
 * - `connectionLost`, naming the chains that cannot serve a read, when one
 *   cannot to begin with, stops being able to during the read, or every
 *   transport in a chain's order failed to reach its node and stays down;
 * - `failedOnHealthyConnection` when every transport tried failed to reach
 *   its node, and, re-checked, they are fine: the read itself is the
 *   problem;
 * - `failed` for any other error;
 * - `succeeded` with the read's value otherwise.
 *
 * Each chain's part of the read goes through its runner (`forCalls`, or
 * `forLogs` for Ethereum's logs), which runs it on the next transport in
 * that chain's order when one fails to reach its node.
 *
 * @param connections The two chains.
 * @param read The read, given the runner per chain.
 * @param kind Whether Ethereum's calls or logs order applies.
 * @returns The outcome, once.
 */
export function readThroughConnections$<T>(
    connections: ProofRequestConnections,
    read: (clients: ConnectedReadClients) => Promise<T>,
    kind: 'calls' | 'logs' = 'calls'
): Observable<ConnectedRead<T>> {
    const readWhileReady$ = defer((): Observable<ConnectedRead<T>> => {
        // A failed request sends its transport to re-check itself, which is
        // not a loss: what the failure was is decided once the read settles.
        const readSettled$ = new Subject<void>();
        const lostWhileReading$ = notReady$(connections, true).pipe(
            filter((names) => names.length > 0),
            take(1),
            map((waitingOn) => ({
                outcome: 'connectionLost' as const,
                waitingOn,
            })),
            takeUntil(readSettled$)
        );
        const result$ = defer(() => from(read(connectedReadClientsOf(connections, kind)))).pipe(
            map((value) => ({ outcome: 'succeeded' as const, value })),
            catchError((error: unknown) => {
                readSettled$.next();
                if (
                    error instanceof ConnectionNotReadyError &&
                    error.notReady.some(({ state }) => state.node === 'noResponse')
                )
                    return outcomeAfterRecheck$(connections, error);
                if (error instanceof ConnectionNotReadyError)
                    return of({
                        outcome: 'connectionLost' as const,
                        waitingOn: [
                            ...new Set(
                                error.notReady.map(
                                    ({ transport }) => transport.split('.')[0] as ConnectionName
                                )
                            ),
                        ],
                    });
                return of({
                    outcome: 'failed' as const,
                    error: messageOf(error),
                });
            })
        );
        return merge(lostWhileReading$, result$).pipe(take(1));
    });

    return notReady$(connections).pipe(
        take(1),
        switchMap((waitingOn) =>
            waitingOn.length === 0
                ? readWhileReady$
                : of({ outcome: 'connectionLost' as const, waitingOn })
        )
    );
}
