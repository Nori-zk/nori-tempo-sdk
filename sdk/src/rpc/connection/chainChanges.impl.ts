import {
    catchError,
    defer,
    distinctUntilChanged,
    EMPTY,
    exhaustMap,
    filter,
    map,
    NEVER,
    type Observable,
    of,
    ReplaySubject,
    scan,
    skipWhile,
    startWith,
    Subject,
    switchMap,
    throwError,
    timer,
} from 'rxjs';
import { dataOnEntry$, heldAcrossMoves, stateOf$, stateOnEntry$, type StartedMachine } from '../../utils/machines.js';
import { messageOf } from '../../utils/messageOf.js';
import { MAX_BLOCK_RANGE_PER_QUERY } from '../evm/blockRanges.js';
import { blockNumber$ } from '../evm/blockNumber.js';
import { type EthereumLogsFilter } from '../eth/topics.js';
import { ChainChangesGraph, type ChainChangesState } from './chainChanges.js';
import { type SubscriptionEvent, SubscriptionRefusedError } from './jsonRpcTopic.js';
import {
    type Ethereum,
    ethereumCallsUsable$,
    forCalls$,
    forLogs$,
    subscriptionsOf,
    type SubscriptionTransport,
    type Tempo,
} from './connections.js';

/** A state of the chain changes machine but `closed`. */
type FollowingState = Exclude<ChainChangesState, { node: 'closed' }>;

/** Where a poll got to: the latest block, and whether the blocks it covered changed the chain. */
type Poll = {
    lastBlock: number;
    changed: boolean;
};

/**
 * Whether the machine follows the chain in a state: subscribed and
 * acknowledged, or polled at least once.
 *
 * @param data A state's data.
 * @returns `true` once it has.
 */
const followed = (data: FollowingState['data']): boolean =>
    'acknowledged' in data ? data.acknowledged : data.lastBlock !== undefined;

/**
 * Starts following whether a chain changes: subscribed on the first
 * transport in its subscriptions order that is usable and serves the
 * subscription, else polling through its calls order.
 *
 * @param chain The Ethereum or Tempo chain.
 * @param logsFilter The logs that count as a change; every new block when omitted.
 * @returns The running machine; `changes` counts the changes. Its control:
 *   - `close()`: moves the machine to `closed`.
 */
export function createChainChangesMachine(chain: Ethereum | Tempo, logsFilter?: EthereumLogsFilter) {
    const { subscribable$, ethSubscribe$, pollIntervalMs } = subscriptionsOf(chain);
    const close$ = new Subject<void>();
    const started$ = new ReplaySubject<StartedMachine<ChainChangesState>>(1);
    const state$ = stateOf$(started$);
    const params = logsFilter === undefined ? ['newHeads'] : ['logs', logsFilter];

    // One subscription per transport, kept while a push loops back to
    // `subscribed`; a state's data holds the transport's name as a string.
    const pushesOn: Record<string, Observable<SubscriptionEvent<unknown>>> = {
        websocket: ethSubscribe$('websocket', params).pipe(heldAcrossMoves()),
        wallet: ethSubscribe$('wallet', params).pipe(heldAcrossMoves()),
    };

    /**
     * The transport to subscribe on: the first usable one not in
     * `unsupported`, as it changes; `undefined` while there is none. The
     * transport a subscription was lost on (`lostOn`) is left out until it
     * has been unusable once.
     */
    const chosen$ = (unsupported: string[], lostOn?: string) =>
        subscribable$.pipe(
            scan(
                ({ waiting }, usable) => ({
                    waiting: waiting && lostOn !== undefined && usable.some((transport) => transport === lostOn),
                    usable,
                }),
                { waiting: true, usable: [] as SubscriptionTransport[] }
            ),
            map(({ waiting, usable }) =>
                usable.find((transport) => !unsupported.includes(transport) && !(waiting && transport === lostOn))
            ),
            distinctUntilChanged()
        );

    /**
     * One poll from `lastBlock`: the latest block, and whether a new block
     * (or with a filter, a matching log in the new blocks) arrived since;
     * `undefined` when no block did. The first poll only reads the latest
     * block; a gap longer than one log query counts as one change.
     */
    const poll$ = (lastBlock: number | undefined): Observable<Poll | undefined> =>
        forCalls$(chain, (provider) => blockNumber$(provider, 'latest')).pipe(
            switchMap((latest) => {
                if (lastBlock === undefined) return of({ lastBlock: latest, changed: false });
                if (latest <= lastBlock) return of(undefined);
                if (logsFilter === undefined || latest - lastBlock > MAX_BLOCK_RANGE_PER_QUERY)
                    return of({ lastBlock: latest, changed: true });
                return forLogs$(chain, (provider) =>
                    defer(() => provider.getLogs({ ...logsFilter, fromBlock: lastBlock + 1, toBlock: latest }))
                ).pipe(map((logs) => ({ lastBlock: latest, changed: logs.length > 0 })));
            })
        );

    const entered$ = stateOnEntry$(state$).pipe(
        filter((state): state is FollowingState => state.node !== 'closed')
    );

    const machine = ChainChangesGraph.implement({
        pushes: {
            $: () =>
                dataOnEntry$(state$, 'subscribed').pipe(
                    switchMap(({ transport }) =>
                        pushesOn[transport].pipe(
                            // Only a refusal is an error; a subscription ending any other way is lost.
                            catchError((error: unknown) =>
                                error instanceof SubscriptionRefusedError ? throwError(() => error) : EMPTY
                            )
                        )
                    )
                ),
            next: (push, _dest, source) =>
                push.kind === 'acknowledged'
                    ? { ...source, acknowledged: true }
                    : { ...source, changes: source.changes + 1 },
            error: (_refused, _dest, source) => ({
                changes: source.changes + 1,
                unsupported: [...source.unsupported, source.transport],
                lastBlock: undefined,
                lostOn: undefined,
            }),
            complete: (_lost, _dest, source) => ({
                changes: source.changes + 1,
                unsupported: source.unsupported,
                lastBlock: undefined,
                lostOn: source.transport,
            }),
        },
        subscribable: {
            $: () =>
                entered$.pipe(
                    switchMap((state) =>
                        chosen$(state.data.unsupported, 'lostOn' in state.data ? state.data.lostOn : undefined).pipe(
                            filter(
                                (transport): transport is SubscriptionTransport =>
                                    transport !== undefined &&
                                    (state.node !== 'subscribed' || transport !== state.data.transport)
                            )
                        )
                    )
                ),
            next: (transport, _dest, source) => ({
                changes: source.changes + (followed(source) ? 1 : 0),
                unsupported: source.unsupported,
                transport,
                acknowledged: false,
            }),
        },
        unsubscribable: {
            $: () =>
                dataOnEntry$(state$, 'subscribed').pipe(
                    switchMap(({ unsupported }) => chosen$(unsupported)),
                    filter((transport) => transport === undefined)
                ),
            next: (_none, _dest, source) => ({
                changes: source.changes + 1,
                unsupported: source.unsupported,
                lastBlock: undefined,
                lostOn: undefined,
            }),
        },
        polls: {
            $: () =>
                dataOnEntry$(state$, 'polling').pipe(
                    switchMap(({ lastBlock }) =>
                        // It polls only while the chain's connection can take a call, and waits in `polling` otherwise.
                        ethereumCallsUsable$(chain).pipe(
                            switchMap((usable) =>
                                !usable
                                    ? NEVER
                                    : // The first poll goes out at once: it is where the machine starts following from.
                                      (lastBlock === undefined
                                          ? timer(pollIntervalMs, pollIntervalMs).pipe(startWith(0))
                                          : timer(pollIntervalMs, pollIntervalMs)
                                      ).pipe(
                                          exhaustMap(() => poll$(lastBlock)),
                                          filter((poll): poll is Poll => poll !== undefined)
                                      )
                            )
                        )
                    )
                ),
            next: ({ lastBlock, changed }, _dest, source) => ({
                ...source,
                lastBlock,
                changes: source.changes + (changed ? 1 : 0),
            }),
            error: (failure: unknown, _dest, source) => ({ ...source, error: messageOf(failure) }),
        },
        pollDue: {
            $: () => timer(pollIntervalMs),
            next: (_due, _dest, source) => ({
                changes: source.changes,
                unsupported: source.unsupported,
                lastBlock: source.lastBlock,
                lostOn: source.lostOn,
            }),
        },
        close: {
            $: () => close$,
            next: () => ({}),
        },
    });

    const running = machine.close().start('polling');
    started$.next(running);

    return Object.assign(running, { close: () => close$.next() });
}

/** A running chain changes machine, with `close()`. */
export type ChainChanges = ReturnType<typeof createChainChangesMachine>;

/**
 * A running chain changes machine's changes, for a reading machine's
 * `refreshOn` to gate on: the count of changes once the machine follows the
 * chain (subscribed and acknowledged, or its first poll has read the latest
 * block), then at each change. It starts nothing: the machine is started
 * and closed by its owner.
 *
 * @param changes The running chain changes machine.
 * @returns The count of changes: first where it follows from, then at each change.
 */
export const changesOf$ = (changes: ChainChanges): Observable<number> =>
    changes.state$.pipe(
        filter((state): state is FollowingState => state.node !== 'closed'),
        skipWhile(({ data }) => !followed(data)),
        map(({ data }) => data.changes),
        distinctUntilChanged()
    );
