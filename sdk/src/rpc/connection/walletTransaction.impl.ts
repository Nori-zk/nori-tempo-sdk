import { isError, type JsonRpcSigner } from 'ethers';
import { catchError, defer, distinctUntilChanged, filter, map, NEVER, type Observable, of, Subject, switchMap, take } from 'rxjs';
import { type ConnectionName, type ProofRequestConnections } from '../../proofRequest/connectedRead.js';
import { sentTransactionReceiptRead } from '../../transaction/sentTransaction.impl.js';
import { type RequestOutcome, requestOutcomes } from '../../utils/machines.js';
import { messageOf } from '../../utils/messageOf.js';
import { type ReadRetryBackoff, startReadThroughConnectionsMachine } from './readThroughConnections.impl.js';
import { WalletTransactionGraph } from './walletTransaction.js';

/** The transaction to send, given the wallet's signer: e.g. a contract call, which emits the sent transaction once. */
export type WalletCall = (signer: JsonRpcSigner) => Observable<{ hash: string }>;

/** How one request to the wallet ended: the edge out of `askingToSign` it takes, with that node's data. */
type SendOutcome = RequestOutcome<typeof WalletTransactionGraph, 'signed' | 'userDeclined' | 'sendRefused'>;

/**
 * Starts sending one transaction through the user's wallet on `chain`: it
 * asks the wallet to sign `call` once the wallet is ready, then reads the
 * transaction's receipt until it is mined.
 *
 * @param connections The Ethereum and Tempo chains, with their running connectivity machines.
 * @param chain The chain whose wallet signs and sends it.
 * @param call The transaction, given the wallet's signer.
 * @param backoff How long a failed receipt read waits before reading again.
 * @returns The running machine; `current` carries the receipt once mined. Its controls:
 *   - `send()`: asks the wallet again, after a decline or a failure.
 *   - `retry()`: reads the receipt again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export function createWalletTransactionMachine(
    connections: ProofRequestConnections,
    chain: ConnectionName,
    call: WalletCall,
    backoff: ReadRetryBackoff = {}
) {
    const wallet = connections[chain].wallet;
    const send$ = new Subject<void>();
    const walletReady$ = (wallet.connection?.state$ ?? NEVER).pipe(
        map(({ node }) => node === 'ready'),
        distinctUntilChanged()
    );

    const machine = startReadThroughConnectionsMachine(WalletTransactionGraph, {
        connections,
        ...sentTransactionReceiptRead(connections, chain),
        backoff,
        start: { node: 'waitingForWallet', data: {} },
        ownTransitions: (_read$, state$) => {
            const taking = requestOutcomes(
                state$,
                'askingToSign',
                (): Observable<SendOutcome> =>
                    wallet.ready$().pipe(
                        switchMap((provider) => defer(() => provider.getSigner())),
                        switchMap((signer) => call(signer)),
                        take(1),
                        map(
                            ({ hash }): SendOutcome => ({
                                transition: 'signed',
                                data: { transactionHash: hash, receipt: undefined, failedReads: 0 },
                            })
                        ),
                        catchError((error: unknown) =>
                            of<SendOutcome>(
                                isError(error, 'ACTION_REJECTED')
                                    ? { transition: 'declined', data: {} }
                                    : { transition: 'sendFailed', data: { error: messageOf(error) } }
                            )
                        )
                    )
            );
            const enter = <TData>(data: TData) => data;
            return {
                walletReady: { $: () => walletReady$.pipe(filter(Boolean)), next: () => ({}) },
                signed: { $: () => taking('signed'), next: enter },
                declined: { $: () => taking('declined'), next: enter },
                sendFailed: { $: () => taking('sendFailed'), next: enter },
                walletLost: {
                    $: () => walletReady$.pipe(filter((ready) => !ready)),
                    next: () => ({ error: 'The wallet disconnected before the transaction was sent.' }),
                },
                send: { $: () => send$, next: () => ({}) },
            };
        },
    });

    return Object.assign(machine, { send: () => send$.next() });
}
