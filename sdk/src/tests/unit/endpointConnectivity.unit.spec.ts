import { BehaviorSubject, defer, filter, of, Subject, throwError } from 'rxjs';
import { httpConnection } from '../../rpc/connection/httpConnection.impl.js';
import type { EthereumHealth } from '../../rpc/eth/ethereumHttp.js';
import { EXPECTED_TEMPO_CHAIN_ID, FAST_TIMINGS, statesDuring, waitForNode } from '../testUtils.js';

type TempoAnswer = 'answers' | 'down' | 'otherChain';

/**
 * A Tempo endpoint set whose answers per endpoint and network the test
 * controls. The first check runs as the machine starts, so answers that
 * matter to it are given up front.
 */
function startTempoEndpoints(
    rpcUrls: string[],
    initialAnswers: Record<string, TempoAnswer> = {}
) {
    const answers = new Map<string, TempoAnswer>(
        rpcUrls.map((url) => [url, initialAnswers[url] ?? 'answers'])
    );
    const checked: string[] = [];
    const network$ = new BehaviorSubject<'online' | 'offline'>('online');
    const readFailed$ = new Subject<void>();
    const close$ = new Subject<void>();
    const machine = httpConnection<EthereumHealth>({
        ...FAST_TIMINGS,
        urls: rpcUrls,
        checkHealth: (url) =>
            defer(() => {
                checked.push(url);
                const answer = answers.get(url);
                if (answer === 'down') return throwError(() => new Error(`${url} did not answer.`));
                if (answer === 'otherChain')
                    return of({
                        outcome: 'onOtherNetwork' as const,
                        url,
                        found: '4217',
                        expected: EXPECTED_TEMPO_CHAIN_ID.toString(),
                    });
                return of({
                    outcome: 'onExpectedNetwork' as const,
                    url,
                    health: { blockNumber: 1 },
                    checkedAt: 0,
                });
            }),
        networkWentOffline$: network$.pipe(
            filter((status) => status === 'offline')
        ),
        networkCameOnline$: network$.pipe(
            filter((status) => status === 'online')
        ),
        readFailed$,
        close$,
    });
    return { machine, answers, checked, network$, readFailed$, close$ };
}

describe('HTTP connection machine, over Tempo RPC endpoints', () => {
    test('moves on to the next endpoint when one is down', async () => {
        const { machine, checked, close$ } = startTempoEndpoints(
            ['https://first.test', 'https://second.test'],
            { 'https://first.test': 'down' }
        );
        const ready = await waitForNode(machine, 'ready');
        expect(ready.data).toEqual(
            expect.objectContaining({ url: 'https://second.test' })
        );
        expect(checked.slice(0, 2)).toEqual([
            'https://first.test',
            'https://second.test',
        ]);
        close$.next();
    });

    test('an endpoint on another chain says which, and keeps checking until one is right', async () => {
        const { machine, answers, close$ } = startTempoEndpoints(
            ['https://only.test'],
            {
                'https://only.test': 'otherChain',
            }
        );
        const wrong = await waitForNode(machine, 'wrongNetwork');
        expect(wrong.data).toEqual({
            url: 'https://only.test',
            found: '4217',
            expected: EXPECTED_TEMPO_CHAIN_ID.toString(),
            failedChecks: 1,
        });
        answers.set('https://only.test', 'answers');
        await waitForNode(machine, 'ready');
        close$.next();
    });

    test('background checks stay on the endpoint that passed', async () => {
        const { machine, checked, close$ } = startTempoEndpoints([
            'https://first.test',
            'https://second.test',
        ]);
        await waitForNode(machine, 'ready');
        const states = await statesDuring(machine, 350);
        close$.next();
        expect(new Set(states.map(({ node }) => node))).toEqual(new Set(['ready']));
        expect(new Set(checked)).toEqual(new Set(['https://first.test']));
    });

    test('a failed read checks at once, and going offline and back recovers', async () => {
        const { machine, answers, readFailed$, network$, close$ } =
            startTempoEndpoints(['https://only.test']);
        await waitForNode(machine, 'ready');
        answers.set('https://only.test', 'down');
        readFailed$.next();
        await waitForNode(machine, 'unreachable');
        network$.next('offline');
        await waitForNode(machine, 'offline');
        answers.set('https://only.test', 'answers');
        network$.next('online');
        await waitForNode(machine, 'ready');
        close$.next();
    });
});
