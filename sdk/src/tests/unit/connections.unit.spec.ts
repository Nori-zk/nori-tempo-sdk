import { BehaviorSubject, defer, filter, firstValueFrom, Observable, of, Subject, throwError, timeout } from 'rxjs';
import { type ChainChangesState } from '../../rpc/connection/chainChanges.js';
import { createChainChangesMachine } from '../../rpc/connection/chainChanges.impl.js';
import { ConnectionNotReadyError } from '../../rpc/connection/connectionNotReady.js';
import { ethereumChain, type EthereumTransports, forCalls$, forLogs$ } from '../../rpc/connection/connections.js';
import { MAX_BLOCK_RANGE_PER_QUERY } from '../../rpc/evm/blockRanges.js';
import { NoWalletConfiguredError } from '../../rpc/eth/errors.js';
import { EvmRpcTransportError } from '../../rpc/evm/errors.js';
import { QUEUE_ADDRESS, statesDuring, waitForNode } from '../testUtils.js';
import { type GraphState } from '../../utils/machines.js';

/** A transport whose machine's node the test sets, standing in for a real one. */
function fakeTransport(name: string, node: string) {
    const state$ = new BehaviorSubject<GraphState>({ node, data: {} });
    const reported = { count: 0 };
    return {
        name,
        state$,
        reported,
        transport: {
            connection: { state$ },
            current: () => ({ name }),
            reportReadFailed: () => {
                reported.count++;
            },
            close: (): void => undefined,
        },
    };
}

/**
 * A websocket transport whose socket subscribes through `subscribe$`;
 * `acknowledge()` answers the last subscribe request as a node does, with
 * the subscription's id.
 */
function fakeWebsocket(node: string, subscribe$: Subject<unknown>) {
    const fake = fakeTransport('websocket', node);
    const requests = { lastId: 0 };
    const socket = {
        multiplex: (subscribeMessage: () => { id: number }) =>
            new Observable((subscriber) => {
                requests.lastId = subscribeMessage().id;
                const subscription = subscribe$.subscribe(subscriber);
                return () => subscription.unsubscribe();
            }),
        forceReconnect: () => {
            fake.reported.count++;
        },
    };
    const acknowledge = () => subscribe$.next({ id: requests.lastId, result: '0x1' });
    return { ...fake, transport: { ...fake.transport, socket }, acknowledge };
}

const chainOf = (transports: Record<string, unknown>, order: Parameters<typeof ethereumChain>[1]) =>
    ethereumChain(transports as unknown as EthereumTransports, order, 20);

/** The fake transport's name, from its provider. */
const nameOf = (provider: unknown) => (provider as { name: string }).name;

describe('forCalls$ and forLogs$', () => {
    test('run on the first ready transport in the caller order', async () => {
        const http = fakeTransport('http', 'ready');
        const wallet = fakeTransport('wallet', 'ready');
        const ethereum = chainOf(
            { http: http.transport, wallet: wallet.transport },
            { calls: ['wallet', 'http'], logs: ['http', 'wallet'] }
        );
        const used = (provider: unknown) => of(nameOf(provider));
        expect(await firstValueFrom(forCalls$(ethereum, used))).toBe('wallet');
        expect(await firstValueFrom(forLogs$(ethereum, used))).toBe('http');
    });

    test('skip a transport that is not ready', async () => {
        const http = fakeTransport('http', 'unreachable');
        const wallet = fakeTransport('wallet', 'ready');
        const ethereum = chainOf(
            { http: http.transport, wallet: wallet.transport },
            { calls: ['http', 'wallet'], logs: ['http'] }
        );
        expect(await firstValueFrom(forCalls$(ethereum, (provider) => of(nameOf(provider))))).toBe('wallet');
    });

    test('a request that never reached the node tells that transport and runs again on the next', async () => {
        const http = fakeTransport('http', 'ready');
        const wallet = fakeTransport('wallet', 'ready');
        const ethereum = chainOf(
            { http: http.transport, wallet: wallet.transport },
            { calls: ['http', 'wallet'], logs: ['http'] }
        );
        const runs: string[] = [];
        const result = await firstValueFrom(
            forCalls$(ethereum, (provider) =>
                defer(() => {
                    const name = nameOf(provider);
                    runs.push(name);
                    return name === 'http'
                        ? throwError(() => new EvmRpcTransportError('no response', undefined))
                        : of(name);
                })
            )
        );
        expect(result).toBe('wallet');
        expect(runs).toEqual(['http', 'wallet']);
        expect(http.reported.count).toBe(1);
        expect(wallet.reported.count).toBe(0);
    });

    test('any other failure is thrown as is, without running again', async () => {
        const http = fakeTransport('http', 'ready');
        const wallet = fakeTransport('wallet', 'ready');
        const ethereum = chainOf(
            { http: http.transport, wallet: wallet.transport },
            { calls: ['http', 'wallet'], logs: ['http'] }
        );
        let runs = 0;
        await expect(
            firstValueFrom(
                forCalls$(ethereum, () =>
                    defer(() => {
                        runs++;
                        return throwError(() => new Error('execution reverted'));
                    })
                )
            )
        ).rejects.toThrow('execution reverted');
        expect(runs).toBe(1);
        expect(http.reported.count).toBe(0);
    });

    test('with nothing ready, fail at once with every transport state', async () => {
        const http = fakeTransport('http', 'unreachable');
        const ethereum = chainOf({ http: http.transport }, { calls: ['http', 'wallet'] });
        const failure = await firstValueFrom(forCalls$(ethereum, () => of('never'))).catch(
            (error: unknown) => error
        );
        expect(failure).toBeInstanceOf(ConnectionNotReadyError);
        expect((failure as ConnectionNotReadyError).notReady).toEqual([
            { transport: 'ethereum.http', state: { node: 'unreachable', data: {} } },
        ]);
    });

    test('several transports for a kind of request and no order given is an error', () => {
        const http = fakeTransport('http', 'ready');
        const wallet = fakeTransport('wallet', 'ready');
        expect(() => chainOf({ http: http.transport, wallet: wallet.transport }, {})).toThrow(
            'give ethereum.order.calls'
        );
    });

    test('the wallet ready$() errors with its own error when no wallet is configured', async () => {
        const ethereum = chainOf({}, {});
        await expect(firstValueFrom(ethereum.wallet.ready$())).rejects.toBeInstanceOf(NoWalletConfiguredError);
    });
});

describe('the chain changes machine', () => {
    /** An http transport whose provider serves `head` as the latest block and `logs` for any range. */
    const fakeHttp = (head: { number: number }, logs: { found: unknown[]; reads: number }) => {
        const http = fakeTransport('http', 'ready');
        const provider = {
            getBlock: async () => ({ ...head }),
            getLogs: async () => {
                logs.reads++;
                return logs.found;
            },
        };
        return { ...http.transport, current: () => provider };
    };

    /** The machine's first state matching `matches`, failing after a second. */
    const stateWhere = (
        machine: ReturnType<typeof createChainChangesMachine>,
        matches: (state: ChainChangesState) => boolean
    ) => firstValueFrom(machine.state$.pipe(filter(matches), timeout(1_000)));

    test('subscribes while the websocket is open, polls while it is not, subscribes again when it reopens', async () => {
        const pushed$ = new Subject<unknown>();
        const websocket = fakeWebsocket('open', pushed$);
        const head = { number: 100 };
        const ethereum = chainOf(
            { http: fakeHttp(head, { found: [], reads: 0 }), websocket: websocket.transport },
            { calls: ['http'], logs: ['http'], subscriptions: ['websocket'] }
        );
        const changes = createChainChangesMachine(ethereum);
        const push = () => pushed$.next({ params: { subscription: 1, result: {} } });

        await stateWhere(changes, (state) => state.node === 'subscribed' && !state.data.acknowledged);
        websocket.acknowledge();
        await stateWhere(changes, (state) => state.node === 'subscribed' && state.data.acknowledged);
        push();
        await stateWhere(changes, (state) => state.node === 'subscribed' && state.data.changes === 1);

        // Losing the websocket is a change; the first poll only reads the latest block.
        websocket.state$.next({ node: 'reconnecting', data: {} });
        await stateWhere(
            changes,
            (state) => state.node === 'polling' && state.data.changes === 2 && state.data.lastBlock === 100
        );
        head.number = 101;
        await stateWhere(
            changes,
            (state) => state.node === 'polling' && state.data.changes === 3 && state.data.lastBlock === 101
        );

        // Subscribing again after polling is a change.
        websocket.state$.next({ node: 'open', data: {} });
        await stateWhere(changes, (state) => state.node === 'subscribed' && state.data.changes === 4);
        push();
        await stateWhere(changes, (state) => state.node === 'subscribed' && state.data.changes === 5);

        changes.close();
        await waitForNode(changes, 'closed', 1_000);
    });

    test('a wallet that does not serve eth_subscribe is recorded, and the machine polls', async () => {
        const wallet = fakeTransport('wallet', 'ready');
        const walletTransport = {
            ...wallet.transport,
            currentWalletProvider: () => ({
                request: async () => {
                    throw new Error('eth_subscribe is not supported.');
                },
            }),
        };
        const ethereum = chainOf(
            { http: fakeHttp({ number: 100 }, { found: [], reads: 0 }), wallet: walletTransport },
            { calls: ['http'], logs: ['http'], subscriptions: ['wallet'] }
        );
        const changes = createChainChangesMachine(ethereum);

        await stateWhere(
            changes,
            (state) => state.node === 'polling' && state.data.unsupported.includes('wallet')
        );
        const nodes = (await statesDuring(changes, 200)).map(({ node }) => node);
        expect(new Set(nodes)).toEqual(new Set(['polling']));

        changes.close();
    });

    test('with a logs filter, a block holding a matching log is a change, and a gap counts once unread', async () => {
        const head = { number: 100 };
        const logs = { found: [] as unknown[], reads: 0 };
        const ethereum = chainOf({ http: fakeHttp(head, logs) }, { calls: ['http'], logs: ['http'] });
        const changes = createChainChangesMachine(ethereum, { address: QUEUE_ADDRESS });

        await stateWhere(changes, (state) => state.node === 'polling' && state.data.lastBlock === 100);
        head.number = 101;
        await stateWhere(
            changes,
            (state) => state.node === 'polling' && state.data.lastBlock === 101 && state.data.changes === 0
        );
        logs.found = [{}];
        head.number = 102;
        await stateWhere(
            changes,
            (state) => state.node === 'polling' && state.data.lastBlock === 102 && state.data.changes === 1
        );

        const readsBeforeGap = logs.reads;
        head.number = 102 + MAX_BLOCK_RANGE_PER_QUERY + 1;
        await stateWhere(
            changes,
            (state) => state.node === 'polling' && state.data.lastBlock === head.number && state.data.changes === 2
        );
        expect(logs.reads).toBe(readsBeforeGap);

        changes.close();
    });
});
