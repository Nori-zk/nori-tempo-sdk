import { getAddress, type JsonRpcSigner, Log, makeError, TransactionReceipt, zeroPadValue } from 'ethers';
import {
    asapScheduler,
    BehaviorSubject,
    defer,
    filter,
    firstValueFrom,
    map,
    type Observable,
    of,
    skip,
    Subject,
    subscribeOn,
    takeUntil,
    takeWhile,
    throwError,
    timeout,
    timer,
    toArray,
} from 'rxjs';
import { NoriProofRequestQueue__factory } from '@nori-zk/ethereum-tempo-bridge';
import type { EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import { type ProofRequestConnections } from '../proofRequest/connectedRead.js';
import type { EthereumHealth } from '../rpc/eth/ethereumHttp.js';
import { httpConnection } from '../rpc/connection/httpConnection.impl.js';
import { ethereumChain, type EthereumTransports } from '../rpc/connection/connections.js';
import { type GraphState } from '../utils/machines.js';

export const QUEUE_ADDRESS = getAddress('0x' + '11'.repeat(20));
export const BRIDGE_ADDRESS = getAddress('0x' + '22'.repeat(20));
export const TARGET_A = getAddress('0x' + 'aa'.repeat(20));
export const TARGET_B = getAddress('0x' + 'bb'.repeat(20));
export const EXPECTED_CHAIN_ID = 11155111n;
export const EXPECTED_TEMPO_CHAIN_ID = 42431n;

/** Health check and retry timings short enough for tests. */
export const FAST_TIMINGS = {
    healthCheckIntervalMs: 100,
    healthCheckTimeoutMs: 200,
    retryBackoff: { initialDelayMs: 20, maxDelayMs: 80 },
};

/** How often the test chains poll while no transport can subscribe. */
export const FAST_POLL_INTERVAL_MS = 50;

/**
 * Waits until a running machine is in `node`, failing after `timeoutMs`.
 *
 * @param machine The running machine.
 * @param node The node to wait for.
 * @param timeoutMs How long to wait.
 * @returns The machine's state in `node`, typed by its graph.
 */
export function waitForNode<TState extends { node: string }, TNode extends TState['node']>(
    machine: { state$: Observable<TState> },
    node: TNode,
    timeoutMs = 30_000
): Promise<Extract<TState, { node: TNode }>> {
    return firstValueFrom(
        machine.state$.pipe(
            filter((state): state is Extract<TState, { node: TNode }> => state.node === node),
            timeout({
                first: timeoutMs,
                with: () => throwError(() => new Error(`Was not in ${node} within ${timeoutMs}ms.`)),
            })
        )
    );
}

/**
 * The nodes a machine moves to from now on, until it reaches `until`
 * (included). Call it before what makes the machine move.
 *
 * @param machine The running machine.
 * @param until The node to stop at, or a test on the state to stop at.
 * @param timeoutMs How long the moves may take.
 * @returns The nodes it moved to, in order, once it reaches `until`.
 */
export function nodesUntil<TState extends { node: string }>(
    machine: { state$: Observable<TState> },
    until: TState['node'] | ((state: TState) => boolean),
    timeoutMs = 30_000
): Promise<string[]> {
    const reached = typeof until === 'string' ? (state: TState) => state.node === until : until;
    return firstValueFrom(
        machine.state$.pipe(
            skip(1),
            takeWhile((state) => !reached(state), true),
            map(({ node }) => node),
            toArray(),
            timeout(timeoutMs)
        )
    );
}

/**
 * The states a machine is in over the next `ms`, starting with where it is now.
 *
 * @param machine The running machine.
 * @param ms How long to watch it.
 * @returns Its states, in order, once the time is up.
 */
export function statesDuring<TState>(machine: { state$: Observable<TState> }, ms: number): Promise<TState[]> {
    return firstValueFrom(machine.state$.pipe(takeUntil(timer(ms)), toArray()));
}

/** A proof request as the fake queue emits it. */
export interface FakeProofRequest {
    requestId: bigint;
    blockNumber: number;
    target: string;
}

/** The transaction hash the fake chain gives the transaction that enqueued `requestId`. */
export const transactionHashOf = (requestId: bigint) =>
    '0x' + requestId.toString(16).padStart(64, '0');

/**
 * A deterministic pseudo-random integer in `[0, n)`.
 *
 * @param seed The seed.
 * @returns A generator of integers below its argument.
 */
export function createRandom(seed: number) {
    let state = seed;
    return (n: number) => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return Math.floor(state / 65536) % n;
    };
}

/**
 * An Ethereum provider serving `ProofRequested` logs, receipts and the
 * latest and finalized blocks for `requests`, as a node would: logs
 * filtered by block range and indexed `target`, requests above
 * `latestBlock` not yet mined. Log queries spanning more than
 * `maxBlockRange` blocks are rejected, as providers do; `failNextReads`
 * makes the next reads fail as an unreachable node does.
 */
export function createFakeEthereumProvider(
    requests: FakeProofRequest[],
    {
        latestBlock,
        finalizedBlock = latestBlock,
        maxBlockRange = 2000,
    }: { latestBlock: number; finalizedBlock?: number; maxBlockRange?: number }
) {
    const queue = NoriProofRequestQueue__factory.createInterface();
    const proofRequested = queue.getEvent('ProofRequested');
    const state = { latestBlock, finalizedBlock, failNextReads: 0 };
    const failIfDown = () => {
        if (state.failNextReads > 0) {
            state.failNextReads--;
            throw new Error('The node did not answer.');
        }
    };
    const logOf = (request: FakeProofRequest, index: number) => {
        const { data, topics } = queue.encodeEventLog(proofRequested, [
            request.requestId,
            request.target,
            '0x' + '00'.repeat(32),
            [],
        ]);
        return {
            address: QUEUE_ADDRESS,
            data,
            topics,
            blockNumber: request.blockNumber,
            blockHash: '0x' + '00'.repeat(32),
            transactionHash: transactionHashOf(request.requestId),
            transactionIndex: 0,
            index,
            removed: false,
        };
    };

    const provider = {
        getBlockNumber: async () => {
            failIfDown();
            return state.latestBlock;
        },
        async getBlock(tag: 'latest' | 'finalized') {
            failIfDown();
            const number = tag === 'finalized' ? state.finalizedBlock : state.latestBlock;
            return {
                number,
                hash: '0x' + number.toString(16).padStart(64, '0'),
                parentHash: '0x' + Math.max(0, number - 1).toString(16).padStart(64, '0'),
                timestamp: number * 12,
            };
        },
        getNetwork: async () => ({ chainId: EXPECTED_CHAIN_ID }),
        async getLogs(filter: {
            fromBlock: number;
            toBlock: number;
            topics?: (string | null)[];
        }) {
            failIfDown();
            const fromBlock = Number(filter.fromBlock);
            const toBlock = Number(filter.toBlock);
            if (toBlock - fromBlock + 1 > maxBlockRange)
                throw new Error('block range too large');
            const targetTopic = filter.topics?.[2]?.toLowerCase();
            return requests
                .filter(
                    (request) =>
                        request.blockNumber >= fromBlock &&
                        request.blockNumber <=
                            Math.min(toBlock, state.latestBlock) &&
                        (targetTopic === undefined ||
                            zeroPadValue(request.target, 32).toLowerCase() ===
                                targetTopic)
                )
                .map(
                    (request, index) =>
                        new Log(logOf(request, index), fakeProvider)
                );
        },
        async getTransactionReceipt(hash: string) {
            failIfDown();
            const request = requests.find(
                (candidate) =>
                    transactionHashOf(candidate.requestId) === hash &&
                    candidate.blockNumber <= state.latestBlock
            );
            if (!request) return null;
            return new TransactionReceipt(
                {
                    to: QUEUE_ADDRESS,
                    from: request.target,
                    contractAddress: null,
                    hash,
                    index: 0,
                    blockHash: '0x' + '00'.repeat(32),
                    blockNumber: request.blockNumber,
                    logsBloom: '0x' + '00'.repeat(256),
                    logs: [logOf(request, 0)],
                    gasUsed: 0n,
                    blobGasUsed: null,
                    cumulativeGasUsed: 0n,
                    gasPrice: 0n,
                    blobGasPrice: null,
                    type: 2,
                    status: 1,
                    root: null,
                },
                fakeProvider
            );
        },
    };
    Object.assign(provider, { provider });
    const fakeProvider = provider as unknown as EthereumProvider;
    return { provider: fakeProvider, state };
}

/** A committed proof queue batch: `[inputQueueCursor, outputQueueCursor)`. */
export interface FakeProofQueueBatch {
    inputQueueCursor: bigint;
    outputQueueCursor: bigint;
}

/**
 * Contiguous batches, each resuming at the previous output cursor.
 *
 * @param sizes How many requests each batch holds.
 * @returns The batches, from cursor 0.
 */
export function createContiguousBatches(
    sizes: number[]
): FakeProofQueueBatch[] {
    let cursor = 0n;
    return sizes.map((size) => {
        const batch = {
            inputQueueCursor: cursor,
            outputQueueCursor: cursor + BigInt(size),
        };
        cursor += BigInt(size);
        return batch;
    });
}

/**
 * A Tempo provider serving the bridge contract's `state()`,
 * `proofQueueBatches` and `findProofQueueBatch` calls at `BRIDGE_ADDRESS`,
 * encoded with the contract's own ABI, and reverting with its errors as the
 * contract does. Batch `i` was committed at Tempo block `500 + i`, with its
 * `ProofQueueBatchCommitted` and `UpdateApplied` logs; the latest block is
 * the one after the last batch. `setBatches`
 * replaces the batches (and the queue cursor, the last batch's output);
 * `outputBlockOf` gives each batch's Ethereum output block; `failNextReads`
 * makes the next reads fail as a node that never answers does, and
 * `failNextCalls` the next contract calls only.
 */
export function createFakeTempoProvider(
    initialBatches: FakeProofQueueBatch[],
    { outputBlockOf = (index: number) => 1000 + index }: { outputBlockOf?: (index: number) => number } = {}
) {
    const bridge = NoriTempoTokenBridge__factory.createInterface();
    const state = { failNextReads: 0, failNextCalls: 0, calls: 0 };
    let batches: FakeProofQueueBatch[] = initialBatches;

    const setBatches = (next: FakeProofQueueBatch[]) => {
        batches = next;
    };
    const entryOf = (index: number) => ({
        root: '0x' + (index % 256).toString(16).padStart(2, '0').repeat(32),
        outputBlockNumber: BigInt(outputBlockOf(index)),
        inputQueueCursor: batches[index].inputQueueCursor,
        outputQueueCursor: batches[index].outputQueueCursor,
        tempoBlockNumber: BigInt(500 + index),
    });
    const failIfDown = () => {
        if (state.failNextReads > 0) {
            state.failNextReads--;
            throw new Error('The node did not answer.');
        }
    };
    const revert = (transaction: { to: string; data: string }, name: string, args: unknown[]) =>
        makeError('execution reverted', 'CALL_EXCEPTION', {
            action: 'call',
            data: bridge.encodeErrorResult(name, args),
            reason: null,
            transaction,
            invocation: null,
            revert: null,
        });

    /** Batch `index`'s log of `event`, at the Tempo block that committed it. */
    const batchLogOf = (index: number, event: 'ProofQueueBatchCommitted' | 'UpdateApplied') => {
        const entry = entryOf(index);
        const { data, topics } =
            event === 'ProofQueueBatchCommitted'
                ? bridge.encodeEventLog(event, [
                      BigInt(index),
                      entry.root,
                      entry.inputQueueCursor,
                      entry.outputQueueCursor,
                      entry.outputBlockNumber,
                  ])
                : bridge.encodeEventLog(event, [0n, entry.outputQueueCursor, '0x' + '00'.repeat(32), BigInt(index + 1)]);
        const blockNumber = Number(entry.tempoBlockNumber);
        return new Log(
            {
                address: BRIDGE_ADDRESS,
                data,
                topics,
                blockNumber,
                blockHash: '0x' + blockNumber.toString(16).padStart(64, '0'),
                transactionHash: '0x' + blockNumber.toString(16).padStart(64, 'f'),
                transactionIndex: 0,
                index: 0,
                removed: false,
            },
            provider as unknown as EthereumProvider
        );
    };

    const provider = {
        getNetwork: async () => ({ chainId: EXPECTED_TEMPO_CHAIN_ID }),
        getBlockNumber: async () => {
            failIfDown();
            return 500 + batches.length;
        },
        async getBlock() {
            failIfDown();
            const number = 500 + batches.length;
            return {
                number,
                hash: '0x' + number.toString(16).padStart(64, '0'),
                parentHash: '0x' + (number - 1).toString(16).padStart(64, '0'),
                timestamp: number,
            };
        },
        async getLogs(filter: { fromBlock: number; toBlock: number; topics?: (string | null)[] }): Promise<Log[]> {
            failIfDown();
            const event = (['ProofQueueBatchCommitted', 'UpdateApplied'] as const).find(
                (name) => bridge.getEvent(name).topicHash === filter.topics?.[0]
            );
            if (event === undefined) return [];
            return batches.flatMap((_, index) => {
                const block = Number(entryOf(index).tempoBlockNumber);
                return block >= Number(filter.fromBlock) && block <= Number(filter.toBlock)
                    ? [batchLogOf(index, event)]
                    : [];
            });
        },
        async call(transaction: { to: string; data: string }) {
            failIfDown();
            if (state.failNextCalls > 0) {
                state.failNextCalls--;
                throw new Error('The node did not answer.');
            }
            state.calls++;
            if (getAddress(transaction.to) !== BRIDGE_ADDRESS) return '0x';
            const call = bridge.parseTransaction({ data: transaction.data });
            if (call === null) throw new Error('Not a bridge call.');
            const count = BigInt(batches.length);
            switch (call.name) {
                case 'state':
                    return bridge.encodeFunctionResult('state', [
                        {
                            verifiedStateRoot: '0x' + '00'.repeat(32),
                            latestHead: 0n,
                            noriBridgeVk: '0x' + '00'.repeat(32),
                            latestHeliosStoreInputHash: '0x' + '00'.repeat(32),
                            ethProofQueueAddress: QUEUE_ADDRESS,
                            ethTokenBridgeAddress: TARGET_A,
                            queueCursor: batches.at(-1)?.outputQueueCursor ?? 0n,
                            proofQueueBatchCount: count,
                        },
                    ]);
                case 'proofQueueBatches': {
                    const [from, length] = call.args as unknown as [bigint, bigint];
                    if (from + length > count)
                        throw revert(transaction, 'ProofQueueBatchNotCommitted', [from + length - 1n, count]);
                    return bridge.encodeFunctionResult('proofQueueBatches', [
                        Array.from({ length: Number(length) }, (_, i) => entryOf(Number(from) + i)),
                    ]);
                }
                case 'findProofQueueBatch': {
                    const [requestId] = call.args as unknown as [bigint];
                    const index = batches.findIndex(
                        (batch) => batch.inputQueueCursor <= requestId && requestId < batch.outputQueueCursor
                    );
                    if (index === -1) throw revert(transaction, 'NoProofQueueBatchCovers', [requestId]);
                    return bridge.encodeFunctionResult('findProofQueueBatch', [BigInt(index), entryOf(index)]);
                }
                default:
                    throw new Error(`The fake bridge does not serve ${call.name}.`);
            }
        },
    };
    Object.assign(provider, { provider });
    return { provider: provider as unknown as EthereumProvider, state, setBatches };
}

/**
 * A wallet transport whose machine's node the test sets (`state$`): a
 * stand-in for the user's wallet, which only signs. Its signer is `signer`.
 *
 * @param node The node its machine starts in (default: `ready`).
 * @returns The transport, its states and its signer.
 */
export function createFakeWallet(node = 'ready') {
    const state$ = new BehaviorSubject<GraphState>({ node, data: {} });
    const signer = { address: TARGET_A } as unknown as JsonRpcSigner;
    const wallet = {
        connection: { state$ },
        current: () => ({ getSigner: () => Promise.resolve(signer) }),
        currentWalletProvider: (): undefined => undefined,
        chooseWallet: (): void => undefined,
        switchToExpectedChain: (): void => undefined,
        reportReadFailed: (): void => undefined,
        close: (): void => undefined,
    } as unknown as NonNullable<EthereumTransports['wallet']>;
    return { wallet, state$, signer };
}

/**
 * Both connections, each a real connectivity machine over a controllable
 * world: whether each endpoint answers its health checks, and whether the
 * network is online. Reads go through `provider` and `tempoProvider`.
 *
 * @param provider The Ethereum provider reads go through.
 * @param tempoProvider The Tempo provider reads go through.
 * @param wallet An Ethereum wallet transport (`createFakeWallet`); reads still go through `provider`.
 * @returns The connections, and the switches that drive them.
 */
export function createTestConnections(
    provider: EthereumProvider,
    tempoProvider: EthereumProvider,
    wallet?: EthereumTransports['wallet']
) {
    // `…GoesDownOnReadFailure`: the endpoint stops answering at the moment a
    // read reports failing to reach it, so the re-check finds it down.
    const world = {
        ethereumAnswers: true,
        tempoAnswers: true,
        ethereumGoesDownOnReadFailure: false,
        tempoGoesDownOnReadFailure: false,
    };
    const network$ = new BehaviorSubject<'online' | 'offline'>('online');
    const ethereumReadFailures = { count: 0 };
    const tempoReadFailures = { count: 0 };

    const ethereumReadFailed$ = new Subject<void>();
    const ethereumClose$ = new Subject<void>();
    const ethereumConnection = httpConnection<EthereumHealth>({
        ...FAST_TIMINGS,
        urls: ['https://ethereum.test'],
        checkHealth: (url) =>
            defer(() =>
                world.ethereumAnswers
                    ? of({ outcome: 'onExpectedNetwork' as const, url, health: { blockNumber: 1 }, checkedAt: 0 })
                    : throwError(() => new Error('The Ethereum node did not answer.'))
            ).pipe(subscribeOn(asapScheduler)),
        networkWentOffline$: network$.pipe(
            filter((status) => status === 'offline')
        ),
        networkCameOnline$: network$.pipe(
            filter((status) => status === 'online')
        ),
        readFailed$: ethereumReadFailed$,
        close$: ethereumClose$,
    });

    const tempoReadFailed$ = new Subject<void>();
    const tempoClose$ = new Subject<void>();
    const tempoConnection = httpConnection<EthereumHealth>({
        ...FAST_TIMINGS,
        urls: ['https://tempo.test'],
        checkHealth: (url) =>
            defer(() =>
                world.tempoAnswers
                    ? of({ outcome: 'onExpectedNetwork' as const, url, health: { blockNumber: 1 }, checkedAt: 0 })
                    : throwError(() => new Error('The Tempo node did not answer.'))
            ).pipe(subscribeOn(asapScheduler)),
        networkWentOffline$: network$.pipe(
            filter((status) => status === 'offline')
        ),
        networkCameOnline$: network$.pipe(
            filter((status) => status === 'online')
        ),
        readFailed$: tempoReadFailed$,
        close$: tempoClose$,
    });

    const connections: ProofRequestConnections = {
        ethereum: ethereumChain(
            {
                http: {
                    connection: ethereumConnection,
                    current: () => provider,
                    reportReadFailed: () => {
                        ethereumReadFailures.count++;
                        if (world.ethereumGoesDownOnReadFailure)
                            world.ethereumAnswers = false;
                        ethereumReadFailed$.next();
                    },
                    close: () => ethereumClose$.next(),
                },
                wallet,
            },
            // Reads go through http; the wallet only signs.
            wallet && { calls: ['http'], logs: ['http'] },
            FAST_POLL_INTERVAL_MS
        ),
        tempo: ethereumChain(
            {
                http: {
                    connection: tempoConnection,
                    current: () => tempoProvider,
                    reportReadFailed: () => {
                        tempoReadFailures.count++;
                        if (world.tempoGoesDownOnReadFailure)
                            world.tempoAnswers = false;
                        tempoReadFailed$.next();
                    },
                    close: () => tempoClose$.next(),
                },
            },
            {},
            FAST_POLL_INTERVAL_MS,
            'tempo'
        ),
    };
    return {
        connections,
        world,
        network$,
        ethereumReadFailures,
        tempoReadFailures,
        close: () => {
            ethereumClose$.next();
            tempoClose$.next();
        },
    };
}
