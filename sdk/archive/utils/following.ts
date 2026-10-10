import { filter, map, type Observable, shareReplay, switchMap, take } from 'rxjs';
import { dataOnEntry$, type GraphState } from './machines.js';

/** A running machine another one follows. */
interface Followed<TState extends GraphState> {
    state$: Observable<TState>;
    close(): void;
}

/**
 * A machine started once on entering `node`, kept across the node's
 * self-loops, and closed on leaving it.
 *
 * @param state$ The following machine's states.
 * @param node The node that follows it.
 * @param start Starts the machine, given the node's data on entry.
 * @returns The machine, once the following machine enters `node`.
 */
export function startedAt<TState extends GraphState, TNode extends TState['node'], TFollowed>(
    state$: Observable<TState>,
    node: TNode,
    start: (data: Extract<TState, { node: TNode }>['data']) => TFollowed & { close(): void }
): Observable<TFollowed & { close(): void }> {
    const started$ = state$.pipe(
        filter((state): state is Extract<TState, { node: TNode }> => state.node === node),
        take(1),
        map(({ data }) => start(data)),
        shareReplay(1)
    );
    started$
        .pipe(
            switchMap((followed) =>
                state$.pipe(
                    filter((state) => state.node !== node),
                    take(1),
                    map(() => followed)
                )
            )
        )
        .subscribe((followed) => followed.close());
    return started$;
}

/**
 * The two transitions of a node that follows a machine: `moved`, a
 * self-loop each time the followed machine's node changes before it is
 * done, and `done`, which leaves the node once it is.
 *
 * @param state$ The following machine's states.
 * @param node The node that follows it.
 * @param followed$ The followed machine, from `startedAt` (or one running already).
 * @param held Which node of the followed machine the node's data holds.
 * @param done Whether the followed machine is done.
 * @param nodeOf The node a state of the followed machine is held as (default: its own node).
 * @returns The `$` of `moved`, emitting the followed machine's new node, and of `done`, emitting its state.
 */
export function followTransitions<
    TState extends GraphState,
    TNode extends TState['node'],
    TFollowedState extends GraphState,
    TDone extends TFollowedState,
    THeld extends string = TFollowedState['node'],
>(
    state$: Observable<TState>,
    node: TNode,
    followed$: Observable<Followed<TFollowedState>>,
    held: (data: Extract<TState, { node: TNode }>['data']) => string,
    done: (state: TFollowedState) => state is TDone,
    nodeOf: (state: TFollowedState) => THeld = (state) => state.node as THeld
) {
    const followedStates$ = followed$.pipe(switchMap((followed) => followed.state$));
    return {
        moved$: () =>
            dataOnEntry$(state$, node).pipe(
                switchMap((data) =>
                    followedStates$.pipe(
                        filter((state) => !done(state)),
                        map(nodeOf),
                        filter((followedNode) => followedNode !== held(data)),
                        take(1)
                    )
                )
            ),
        done$: () => followedStates$.pipe(filter(done), take(1)),
    };
}
