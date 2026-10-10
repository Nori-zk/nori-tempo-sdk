import { define, type StateUnion } from '@yaw-rx/ystate';
import { sentTransactionReceiptOf } from '../../transaction/sentTransaction.js';

const { nodes, edges } = sentTransactionReceiptOf();

/**
 * One transaction sent through the user's wallet: asking the wallet to sign
 * and send it, then its receipt, read through the chain's connection
 * (`readThroughConnectionsOf`) until it is mined.
 *
 * - `waitingForWallet`: the wallet is not ready to sign (none chosen, on
 *   another chain, unreachable); it asks once the wallet is ready.
 * - `askingToSign`: the wallet shows the transaction; one request per entry.
 *   Its outcomes: `signed` with the transaction's hash, to `loading`; the
 *   user said no, to `declined`; the wallet or the contract refused it, or
 *   the wallet dropped while asking, to `sendFailed` with the error.
 * - `declined` and `sendFailed` send again only on `send()`: a request the
 *   wallet may still hold is never sent twice by itself.
 * - From `loading` on, the receipt is read through the chain's connection,
 *   and again on each new block until the transaction is mined; `current`
 *   holds it, `receipt.status` 1 for success and 0 for a revert.
 * - `closed` is terminal.
 */
export const WalletTransactionGraph = define({
    nodes: {
        waitingForWallet: {},
        askingToSign: {},
        declined: {},
        sendFailed: { error: '' },
        ...nodes,
    },
    edges: {
        walletReady: { from: 'waitingForWallet', to: 'askingToSign', on: 'walletReady.next' },
        signed: { from: 'askingToSign', to: 'loading', on: 'signed.next' },
        userDeclined: { from: 'askingToSign', to: 'declined', on: 'declined.next' },
        sendRefused: { from: 'askingToSign', to: 'sendFailed', on: 'sendFailed.next' },
        walletLostWhileAsking: { from: 'askingToSign', to: 'sendFailed', on: 'walletLost.next' },
        sendAgainAfterDecline: { from: 'declined', to: 'waitingForWallet', on: 'send.next' },
        sendAgainAfterFailure: { from: 'sendFailed', to: 'waitingForWallet', on: 'send.next' },
        closedWhileWaitingForWallet: { from: 'waitingForWallet', to: 'closed', on: 'close.next' },
        closedWhileAskingToSign: { from: 'askingToSign', to: 'closed', on: 'close.next' },
        closedAfterDecline: { from: 'declined', to: 'closed', on: 'close.next' },
        closedAfterSendFailed: { from: 'sendFailed', to: 'closed', on: 'close.next' },
        ...edges,
    },
});

/** The wallet transaction's state: a node of the graph and its data. */
export type WalletTransactionState = StateUnion<typeof WalletTransactionGraph.nodes>;
