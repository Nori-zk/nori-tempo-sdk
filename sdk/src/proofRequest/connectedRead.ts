import {
    catchError,
    combineLatest,
    defer,
    distinctUntilChanged,
    filter,
    map,
    merge,
    type Observable,
    of,
    skip,
    Subject,
    switchMap,
    take,
    takeUntil,
    throwError,
} from 'rxjs';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { type GraphState, type StartedMachine } from '../utils/machines.js';
import { messageOf } from '../utils/messageOf.js';
import {
    ConnectionNotReadyError,
    type TransportName,
    type TransportState,
} from '../rpc/connection/connectionNotReady.js';
import {
    type Ethereum,
    ethereumCallsUsable$,
    forCalls$,
    forLogs$,
    forTransport$,
    type RequestTransport,
    type Tempo,
    transportUsable$,
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

/** One transport of the two chains, by name: `ethereum.wallet`, `tempo.http`, … */
export type ChainTransportName = Exclude<TransportName, 'nori.websocket'>;

/** What a read needs: a chain, read through its calls order, or one transport of a chain. */
export type ReadNeed = ConnectionName | ChainTransportName;

/**
 * Runs one read on a chain, through the transports of its order; the read
 * is given the transport's provider. Unsubscribing cancels it.
 */
export type ChainRead = <T>(read: (provider: EthereumProvider) => Observable<T>) => Observable<T>;

/**
 * What one read goes through: a runner per chain, and one for the transport
 * the read needs. Each chain's runs its part of the read on the first ready
 * transport in that chain's order and moves on to the next when one fails
 * to reach its node, so a failure is told to the transport of the chain it
 * happened on. `transport` runs it on the transport `needs` names, and only
 * there.
 */
export interface ConnectedReadClients {
    ethereum: ChainRead;
    tempo: ChainRead;
    transport: ChainRead;
}

/** How one read through both chains ended. */
export type ConnectedRead<T> =
    | { outcome: 'succeeded'; value: T }
    | { outcome: 'connectionLost'; waitingOn: ReadNeed[] }
    | { outcome: 'failedOnHealthyConnection'; error: string }
    | { outcome: 'failed'; error: string };

/** Both chains, the ones a read needs unless it says otherwise. */
const BOTH_CHAINS: ReadNeed[] = ['ethereum', 'tempo'];

/**
 * Whether a need names one transport rather than a chain.
 *
 * @param need What a read needs.
 * @returns `true` for a transport.
 */
const isTransportNeed = (need: ReadNeed): need is ChainTransportName => need.includes('.');

/**
 * A transport need's chain and transport.
 *
 * @param need The transport, by name.
 * @returns Its chain and its kind.
 */
const chainAndTransportOf = (need: ChainTransportName) => need.split('.') as [ConnectionName, RequestTransport];

/**
 * The runners a read goes through: Ethereum in its calls or logs order,
 * Tempo in its calls order, and the transport `needs` names. Without one,
 * `transport` errors with `ConnectionNotReadyError`.
 *
 * @param connections The two chains.
 * @param kind Whether Ethereum's calls or logs order applies.
 * @param needs What the read needs.
 * @returns The runner per chain, and the transport's.
 */
export function connectedReadClientsOf(
    connections: ProofRequestConnections,
    kind: 'calls' | 'logs' = 'calls',
    needs: ReadNeed[] = BOTH_CHAINS
): ConnectedReadClients {
    const through = kind === 'logs' ? forLogs$ : forCalls$;
    const transportNeed = needs.find(isTransportNeed);
    return {
        ethereum: (read) => through(connections.ethereum, read),
        tempo: (read) => forCalls$(connections.tempo, read),
        transport: (read) => {
            if (transportNeed === undefined) return throwError(() => new ConnectionNotReadyError([]));
            const [chain, transport] = chainAndTransportOf(transportNeed);
            return forTransport$(connections[chain], transport, read);
        },
    };
}

/**
 * Whether a need can serve a read, as it changes: a chain while a
 * transport in its calls order is usable, a transport while it is.
 *
 * @param connections The two chains.
 * @param need What the read needs.
 * @param whileChecking Count a transport re-checking itself as usable.
 * @returns `true` while it can.
 */
function needUsable$(connections: ProofRequestConnections, need: ReadNeed, whileChecking: boolean) {
    if (!isTransportNeed(need)) return ethereumCallsUsable$(connections[need], whileChecking);
    const [chain, transport] = chainAndTransportOf(need);
    return transportUsable$(connections[chain], transport, whileChecking);
}

/**
 * The needs that cannot serve a read, each time one changes: a chain while
 * no transport in its calls order is usable, a transport while it is not.
 *
 * @param connections The two chains.
 * @param whileChecking Count a transport re-checking itself as able: what a
 *   failed request did is decided once its check settles.
 * @param needs What the read needs.
 * @returns The needs that cannot serve a read, in the order of `needs`.
 */
function notReady$(
    connections: ProofRequestConnections,
    whileChecking = false,
    needs: ReadNeed[] = BOTH_CHAINS
): Observable<ReadNeed[]> {
    return combineLatest(needs.map((need) => needUsable$(connections, need, whileChecking))).pipe(
        map((usable) => needs.filter((_need, i) => !usable[i]))
    );
}

/**
 * Whether two lists of needs are the same.
 *
 * @param a A list of needs.
 * @param b Another list of needs.
 * @returns `true` when they hold the same needs in the same order.
 */
function sameNames(a: ReadNeed[], b: ReadNeed[]): boolean {
    return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * Emits once the needs of a read can serve it: at once if they already can.
 *
 * @param connections The two chains.
 * @param needs What the read needs (default: both chains).
 * @returns A single emission when they are ready.
 */
export function bothReady$(
    connections: ProofRequestConnections,
    needs: ReadNeed[] = BOTH_CHAINS
): Observable<void> {
    return notReady$(connections, false, needs).pipe(
        filter((names) => names.length === 0),
        take(1),
        map((): void => undefined)
    );
}

/**
 * Emits once some needs of a read cannot serve it, naming them: at once if
 * some already cannot.
 *
 * @param connections The two chains.
 * @param needs What the read needs (default: both chains).
 * @returns The needs that cannot serve a read, once.
 */
export function needsNotReady$(
    connections: ProofRequestConnections,
    needs: ReadNeed[] = BOTH_CHAINS
): Observable<ReadNeed[]> {
    return notReady$(connections, false, needs).pipe(
        filter((names) => names.length > 0),
        take(1)
    );
}

/**
 * The needs a waiting machine waits on, each time the set changes while
 * some still cannot serve a read. The set the machine entered with is not
 * repeated: the first emission, the set as it stands when subscribed, is
 * skipped.
 *
 * @param connections The two chains.
 * @param needs What the read needs (default: both chains).
 * @returns The needs that cannot serve a read, when that set changes.
 */
export function waitingOnChanged$(
    connections: ProofRequestConnections,
    needs: ReadNeed[] = BOTH_CHAINS
): Observable<ReadNeed[]> {
    return notReady$(connections, false, needs).pipe(
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
): StartedMachine<GraphState> | undefined {
    const [chainName, kind] = transport.split('.') as [string, 'http' | 'websocket' | 'wallet'];
    if (chainName !== 'ethereum' && chainName !== 'tempo') return undefined;
    return connections[chainName][kind].connection as StartedMachine<GraphState> | undefined;
}

/**
 * Decides what it was when every transport tried on a chain failed to reach
 * its node, once those transports (each already told) have re-checked
 * themselves: every need usable again means the read itself failed;
 * otherwise the connection was lost.
 *
 * @param connections The two chains.
 * @param error The failure, listing the transports that got no response.
 * @param needs What the read needs.
 * @returns The outcome, once they have settled.
 */
function outcomeAfterRecheck$(
    connections: ProofRequestConnections,
    error: ConnectionNotReadyError,
    needs: ReadNeed[]
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
        switchMap(() => notReady$(connections, false, needs).pipe(take(1))),
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
 * The need a transport that was not ready stands for: the transport itself
 * when the read names it, else its chain.
 *
 * @param transport The transport, by name.
 * @param needs What the read needs.
 * @returns The need.
 */
const needOf = (transport: TransportName, needs: ReadNeed[]): ReadNeed =>
    needs.includes(transport as ReadNeed) ? (transport as ReadNeed) : (transport.split('.')[0] as ConnectionName);

/**
 * Runs one read and reports how it ended:
 *
 * - `connectionLost`, naming the needs that cannot serve a read, when one
 *   cannot to begin with, stops being able to during the read, or every
 *   transport tried failed to reach its node and stays down;
 * - `failedOnHealthyConnection` when every transport tried failed to reach
 *   its node, and, re-checked, they are fine: the read itself is the
 *   problem;
 * - `failed` for any other error;
 * - `succeeded` with the read's value otherwise.
 *
 * Each chain's part of the read goes through its runner (`forCalls$`, or
 * `forLogs$` for Ethereum's logs), which runs it on the next transport in
 * that chain's order when one fails to reach its node; a part that needs
 * one transport goes through `transport`.
 *
 * @param connections The two chains.
 * @param read The read, given the runners.
 * @param kind Whether Ethereum's calls or logs order applies.
 * @param needs What the read needs (default: both chains).
 * @returns The outcome, once.
 */
export function readThroughConnections$<T>(
    connections: ProofRequestConnections,
    read: (clients: ConnectedReadClients) => Observable<T>,
    kind: 'calls' | 'logs' = 'calls',
    needs: ReadNeed[] = BOTH_CHAINS
): Observable<ConnectedRead<T>> {
    const readWhileReady$ = defer((): Observable<ConnectedRead<T>> => {
        // A failed request sends its transport to re-check itself, which is
        // not a loss: what the failure was is decided once the read settles.
        const readSettled$ = new Subject<void>();
        const lostWhileReading$ = notReady$(connections, true, needs).pipe(
            filter((names) => names.length > 0),
            take(1),
            map((waitingOn) => ({
                outcome: 'connectionLost' as const,
                waitingOn,
            })),
            takeUntil(readSettled$)
        );
        const result$ = defer(() => read(connectedReadClientsOf(connections, kind, needs))).pipe(
            take(1),
            map((value) => ({ outcome: 'succeeded' as const, value })),
            catchError((error: unknown) => {
                readSettled$.next();
                if (
                    error instanceof ConnectionNotReadyError &&
                    error.notReady.some(({ state }) => state.node === 'noResponse')
                )
                    return outcomeAfterRecheck$(connections, error, needs);
                if (error instanceof ConnectionNotReadyError)
                    return of({
                        outcome: 'connectionLost' as const,
                        waitingOn: [...new Set(error.notReady.map(({ transport }) => needOf(transport, needs)))],
                    });
                return of({
                    outcome: 'failed' as const,
                    error: messageOf(error),
                });
            })
        );
        return merge(lostWhileReading$, result$).pipe(take(1));
    });

    return notReady$(connections, false, needs).pipe(
        take(1),
        switchMap((waitingOn) =>
            waitingOn.length === 0
                ? readWhileReady$
                : of({ outcome: 'connectionLost' as const, waitingOn })
        )
    );
}
