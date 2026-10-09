import { type RunningMachine } from '@yaw-rx/ystate';
import { getAddress, Log, makeError, TransactionReceipt, zeroPadValue } from 'ethers';
import {
    BehaviorSubject,
    filter,
    firstValueFrom,
    type Observable,
    Subject,
} from 'rxjs';
import { NoriProofRequestQueue__factory } from '@nori-zk/ethereum-tempo-bridge';
import type { EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import { type ProofRequestConnections } from '../proofRequest/connectedRead.js';
import type { EthereumHealth } from '../rpc/eth/ethereumHttp.js';
import { httpConnection } from '../rpc/connection/httpConnection.impl.js';
import { ethereumChain } from '../rpc/connection/connections.js';

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

export const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until a running machine reaches `node`, failing after `timeoutMs`.
 *
 * @param machine The running machine.
 * @param node The node to wait for.
 * @param timeoutMs How long to wait.
 * @returns The state at `node`.
 */
export function reach(
    machine: RunningMachine,
    node: string,
    timeoutMs = 30_000
): Promise<{ node: string; data: unknown }> {
    return Promise.race([
        firstValueFrom(
            machine.state$.pipe(filter((state) => state.node === node))
        ),
        sleep(timeoutMs).then(() => {
            throw new Error(`Did not reach ${node} within ${timeoutMs}ms.`);
        }),
    ]);
}

/**
 * Records every node a running machine visits.
 *
 * @param machine The running machine.
 * @returns The visited nodes, in order, as they happen.
 */
export function recordNodes(machine: {
    state$: Observable<{ node: string }>;
}): string[] {
    const nodes: string[] = [];
    machine.state$.subscribe(({ node }) => nodes.push(node));
    return nodes;
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
 * An Ethereum provider serving `ProofRequested` logs and receipts for
 * `requests`, as a node would: logs filtered by block range and indexed
 * `target`, requests above `latestBlock` not yet mined. Log queries spanning
 * more than `maxBlockRange` blocks are rejected, as providers do;
 * `failNextReads` makes the next reads fail as an unreachable node does.
 */
export function createFakeEthereumProvider(
    requests: FakeProofRequest[],
    {
        latestBlock,
        maxBlockRange = 2000,
    }: { latestBlock: number; maxBlockRange?: number }
) {
    const queue = NoriProofRequestQueue__factory.createInterface();
    const proofRequested = queue.getEvent('ProofRequested');
    const state = { latestBlock, failNextReads: 0 };
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
 * contract does. `setBatches` replaces the batches (and the queue cursor,
 * the last batch's output); `failNextReads` makes the next reads fail as a
 * node that never answers does.
 */
export function createFakeTempoProvider(initialBatches: FakeProofQueueBatch[]) {
    const bridge = NoriTempoTokenBridge__factory.createInterface();
    const state = { failNextReads: 0, calls: 0 };
    let batches: FakeProofQueueBatch[] = initialBatches;

    const setBatches = (next: FakeProofQueueBatch[]) => {
        batches = next;
    };
    const entryOf = (index: number) => ({
        root: '0x' + (index % 256).toString(16).padStart(2, '0').repeat(32),
        outputBlockNumber: BigInt(1000 + index),
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

    const provider = {
        getNetwork: async () => ({ chainId: EXPECTED_TEMPO_CHAIN_ID }),
        async call(transaction: { to: string; data: string }) {
            failIfDown();
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
 * Both connections, each a real connectivity machine over a controllable
 * world: whether each endpoint answers its health checks, and whether the
 * network is online. Reads go through `provider` and `tempoProvider`.
 *
 * @param provider The Ethereum provider reads go through.
 * @param tempoProvider The Tempo provider reads go through.
 * @returns The connections, and the switches that drive them.
 */
export function createTestConnections(
    provider: EthereumProvider,
    tempoProvider: EthereumProvider
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
        checkHealth: async (url) => {
            if (!world.ethereumAnswers)
                throw new Error('The Ethereum node did not answer.');
            return {
                outcome: 'onExpectedNetwork',
                url,
                health: { blockNumber: 1 },
                checkedAt: 0,
            };
        },
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
        checkHealth: async (url) => {
            if (!world.tempoAnswers)
                throw new Error('The Tempo node did not answer.');
            return {
                outcome: 'onExpectedNetwork',
                url,
                health: { blockNumber: 1 },
                checkedAt: 0,
            };
        },
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
        ethereum: ethereumChain({
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
        }),
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
            15_000,
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
