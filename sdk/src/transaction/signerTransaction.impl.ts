import { isError, type Signer } from 'ethers';
import { catchError, filter, map, type Observable, of, Subject, switchMap, take } from 'rxjs';
import { type ConnectionName, type ProofRequestConnections } from '../proofRequest/connectedRead.js';
import { ethereumCallsUsable$ } from '../rpc/connection/connections.js';
import { type ReadRetryBackoff, startReadThroughConnectionsMachine } from '../rpc/connection/readThroughConnections.impl.js';
import { messageOf } from '../utils/messageOf.js';
import { type RequestOutcome, requestOutcomes } from '../utils/machines.js';
import { sentTransactionReceiptRead } from './sentTransaction.impl.js';
import { SignerTransactionGraph } from './signerTransaction.js';

/** The transaction to send, given the signer: e.g. a contract call, which emits the sent transaction once. */
export type SignerCall = (signer: Signer) => Observable<{ hash: string }>;

/** How one send ended: the edge out of `sending` it takes, with that node's data. */
type SendOutcome = RequestOutcome<typeof SignerTransactionGraph, 'sent' | 'contractRefused' | 'failedToSend'>;

/**
 * Starts sending one transaction on `chain` with a signer of the app's own,
 * then reads its receipt through the chain's connection until it is mined.
 *
 * @param connections The Ethereum and Tempo chains, with their running connectivity machines.
 * @param chain The chain the transaction is sent on.
 * @param signer The app's signer on that chain, e.g. an ethers `Wallet`.
 * @param call The transaction, given the signer.
 * @param backoff How long a failed receipt read waits before reading again.
 * @returns The running machine; `current` carries the receipt once mined. Its controls:
 *   - `send()`: sends again, after a refusal or a failure.
 *   - `retry()`: reads the receipt again now, without waiting, while failed.
 *   - `close()`: moves the machine to `closed`.
 */
export function createSignerTransactionMachine(
    connections: ProofRequestConnections,
    chain: ConnectionName,
    signer: Signer,
    call: SignerCall,
    backoff: ReadRetryBackoff = {}
) {
    const send$ = new Subject<void>();

    const machine = startReadThroughConnectionsMachine(SignerTransactionGraph, {
        connections,
        ...sentTransactionReceiptRead(connections, chain),
        backoff,
        start: { node: 'sending', data: {} },
        ownTransitions: (_read$, state$) => {
            // One send per entry into `sending`, once the chain's connection can take a call.
            const taking = requestOutcomes(state$, 'sending', () =>
                ethereumCallsUsable$(connections[chain]).pipe(
                    filter(Boolean),
                    take(1),
                    switchMap(() => call(signer)),
                    take(1),
                    map(
                        ({ hash }): SendOutcome => ({
                            transition: 'sent',
                            data: { transactionHash: hash, receipt: undefined, failedReads: 0 },
                        })
                    ),
                    catchError((error: unknown) =>
                        of<SendOutcome>(
                            isError(error, 'CALL_EXCEPTION')
                                ? {
                                      transition: 'refused',
                                      data: { errorName: error.revert?.name ?? error.data ?? 'revert without data' },
                                  }
                                : { transition: 'sendFailed', data: { error: messageOf(error) } }
                        )
                    )
                )
            );
            const enter = <TData>(data: TData) => data;
            return {
                sent: { $: () => taking('sent'), next: enter },
                refused: { $: () => taking('refused'), next: enter },
                sendFailed: { $: () => taking('sendFailed'), next: enter },
                send: { $: () => send$, next: () => ({}) },
            };
        },
    });

    return Object.assign(machine, { send: () => send$.next() });
}
