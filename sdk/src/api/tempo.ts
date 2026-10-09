import { type NoriTempoTokenBridge } from '@nori-zk/tempo-token-bridge';
import {
    catchError,
    distinctUntilChanged,
    EMPTY,
    exhaustMap,
    from,
    map,
    mergeMap,
    type Observable,
    shareReplay,
    startWith,
    take,
} from 'rxjs';
import { forCalls, forSubscriptions, type Tempo } from '../rpc/connection/connections.js';
import {
    type EthereumLogNotification,
    type EthereumLogsFilter,
    latestHeadFrom,
    logsFrom,
    logsSinceFrom,
    newHeadsFrom,
} from '../rpc/eth/topics.js';
import { fetchBridgeState } from '../rpc/tempo/fetchBridgeState.js';
import {
    PROOF_QUEUE_BATCH_COMMITTED_TOPIC,
    proofQueueBatchCommittedOf,
    type ProofQueueBatchCommittedNotification,
    type TempoTransactionReceiptNotification,
    transactionReceiptFrom,
    UPDATE_APPLIED_TOPIC,
} from '../rpc/tempo/topics.js';

export type { ProofQueueBatchCommittedNotification, TempoTransactionReceiptNotification };

/** The bridge contract's whole state, as `state()` returns it. */
export type TempoBridgeState = NoriTempoTokenBridge.BridgeStateStructOutput;

/**
 * The logs matching a filter on Tempo: subscribed in the chain's
 * subscriptions order (its websocket by default), and while none of those is
 * ready, the logs of each new block polled through its calls order, in the
 * same shape.
 *
 * @param tempo The Tempo chain.
 * @param filter The emitting contracts and topics.
 * @returns Each matching log.
 */
export function getTempoLogs$(tempo: Tempo, filter: EthereumLogsFilter): Observable<EthereumLogNotification> {
    return forSubscriptions(tempo, logsFrom, logsSinceFrom, filter, {});
}

/**
 * Each proof queue batch the bridge commits, as its `update` lands.
 *
 * @param tempo The Tempo chain.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns Each committed batch.
 */
export function getProofQueueBatchCommitted$(
    tempo: Tempo,
    bridgeAddress: string
): Observable<ProofQueueBatchCommittedNotification> {
    return getTempoLogs$(tempo, { address: bridgeAddress, topics: [PROOF_QUEUE_BATCH_COMMITTED_TOPIC] }).pipe(
        map(proofQueueBatchCommittedOf)
    );
}

/**
 * The bridge's state: read at once, then again each time an `update` is
 * applied (`UpdateApplied`). Replays the latest.
 *
 * @param tempo The Tempo chain.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @returns The bridge's state each time it changes.
 */
export function getBridgeState$(tempo: Tempo, bridgeAddress: string): Observable<TempoBridgeState> {
    return getTempoLogs$(tempo, { address: bridgeAddress, topics: [UPDATE_APPLIED_TOPIC] }).pipe(
        startWith(undefined),
        // A read that fails is skipped; the next update reads again.
        exhaustMap(() => from(forCalls(tempo, fetchBridgeState, bridgeAddress)).pipe(catchError(() => EMPTY))),
        distinctUntilChanged(
            (previous, current) =>
                previous.latestHead === current.latestHead &&
                previous.queueCursor === current.queueCursor &&
                previous.proofQueueBatchCount === current.proofQueueBatchCount
        ),
        shareReplay({ bufferSize: 1, refCount: true })
    );
}

/**
 * A transaction's receipt, once: read at once, then on each new Tempo block
 * (subscribed, or polled while no subscription transport is ready) until it
 * is mined. A mined transaction is final on Tempo.
 *
 * @param tempo The Tempo chain.
 * @param transactionHash The transaction.
 * @returns One notification once the transaction is mined.
 */
export function getTransactionReceipt$(
    tempo: Tempo,
    transactionHash: string
): Observable<TempoTransactionReceiptNotification> {
    return forSubscriptions(tempo, newHeadsFrom, latestHeadFrom).pipe(
        startWith(undefined),
        exhaustMap(() =>
            from(forCalls(tempo, transactionReceiptFrom, transactionHash)).pipe(catchError(() => EMPTY))
        ),
        mergeMap((receipts) => receipts),
        take(1)
    );
}
