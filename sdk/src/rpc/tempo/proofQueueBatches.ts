import { NoriTempoTokenBridge__factory, type NoriTempoTokenBridge } from '@nori-zk/tempo-token-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { concatMap, defer, from, map, type Observable, reduce } from 'rxjs';
import { evmRpcRead$ } from '../evm/evmRpcRead.js';

/** `proofQueueBatches` reads at most this many consecutive batches per call. */
export const MAX_BATCHES_PER_CALL = 100;

/** A committed proof queue batch, as the bridge stores it. */
type ProofQueueBatch = NoriTempoTokenBridge.ProofRequestRootEntryStructOutput;

/**
 * The runs of consecutive indices among `indices`, each at most
 * `MAX_BATCHES_PER_CALL` long: one `proofQueueBatches` call each.
 *
 * @param indices The proof queue batch indices.
 * @returns Each run's first index and length.
 */
function runsOf(indices: bigint[]): { from: bigint; count: bigint }[] {
    const sorted = [...new Set(indices)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const runs: { from: bigint; count: bigint }[] = [];
    for (const index of sorted) {
        const last = runs[runs.length - 1];
        if (last && last.from + last.count === index && last.count < BigInt(MAX_BATCHES_PER_CALL)) last.count += 1n;
        else runs.push({ from: index, count: 1n });
    }
    return runs;
}

/**
 * The proof queue batches at `proofQueueBatchIndices`, each run of
 * consecutive indices in one `proofQueueBatches` call of at most
 * `MAX_BATCHES_PER_CALL`.
 *
 * Every index must be below the bridge's `proofQueueBatchCount`: batches are
 * append-only and never removed, so an index the contract has not committed
 * is an error.
 *
 * @param provider The Tempo provider used for the reads.
 * @param proofQueueBatchIndices The proof queue batch indices to read.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns One decoded batch per index, in the order given, once.
 */
export const proofQueueBatches$ = (
    provider: EthereumProvider,
    proofQueueBatchIndices: bigint[],
    bridgeAddress: string
): Observable<ProofQueueBatch[]> =>
    defer(() => {
        const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, provider);
        return from(runsOf(proofQueueBatchIndices)).pipe(
            concatMap(({ from: first, count }) =>
                evmRpcRead$(() => bridge.proofQueueBatches(first, count), 'Failed to read proof queue batches.').pipe(
                    map((batches) => batches.map((batch, i): [bigint, ProofQueueBatch] => [first + BigInt(i), batch]))
                )
            ),
            reduce((byIndex, read) => new Map([...byIndex, ...read]), new Map<bigint, ProofQueueBatch>()),
            map((byIndex) =>
                proofQueueBatchIndices.map((index) => {
                    const batch = byIndex.get(index);
                    if (batch === undefined) throw new RangeError(`Proof queue batch ${index} was not read.`);
                    return batch;
                })
            )
        );
    });
