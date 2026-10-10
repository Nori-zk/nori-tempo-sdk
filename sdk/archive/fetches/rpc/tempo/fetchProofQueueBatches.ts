import {
    NoriTempoTokenBridge__factory,
    type NoriTempoTokenBridge,
} from '@nori-zk/tempo-token-bridge';
import { type EthereumProvider } from '@nori-zk/ethereum-tempo-bridge/iso-provider';
import { EthRpcTransportError } from '../eth/errors.js';

/** `proofQueueBatches` reads at most this many consecutive batches per call. */
export const MAX_BATCHES_PER_CALL = 100;

/**
 * Reads the proof queue batches at `proofQueueBatchIndices`, each run of
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
 * @returns One decoded batch per index, in the order given.
 * @throws EthRpcTransportError When a read fails.
 */
export async function fetchProofQueueBatches(
    provider: EthereumProvider,
    proofQueueBatchIndices: bigint[],
    bridgeAddress: string
): Promise<NoriTempoTokenBridge.ProofRequestRootEntryStructOutput[]> {
    const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, provider);
    const sorted = [...new Set(proofQueueBatchIndices)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const runs: Array<{ from: bigint; count: bigint }> = [];
    for (const index of sorted) {
        const last = runs[runs.length - 1];
        if (last && last.from + last.count === index && last.count < BigInt(MAX_BATCHES_PER_CALL))
            last.count += 1n;
        else runs.push({ from: index, count: 1n });
    }

    const byIndex = new Map<bigint, NoriTempoTokenBridge.ProofRequestRootEntryStructOutput>();
    for (const { from, count } of runs) {
        const batches = await bridge.proofQueueBatches(from, count).catch(
            (error: unknown) => {
                throw new EthRpcTransportError('Failed to read proof queue batches.', error);
            }
        );
        batches.forEach((batch, i) => byIndex.set(from + BigInt(i), batch));
    }
    return proofQueueBatchIndices.map((index) => {
        const batch = byIndex.get(index);
        if (batch === undefined) throw new RangeError(`Proof queue batch ${index} was not read.`);
        return batch;
    });
}
