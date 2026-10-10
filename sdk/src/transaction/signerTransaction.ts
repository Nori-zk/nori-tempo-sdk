import { define, type StateUnion } from '@yaw-rx/ystate';
import { sentTransactionReceiptOf } from './sentTransaction.js';

const { nodes, edges } = sentTransactionReceiptOf();

/**
 * One transaction the app sends with a signer of its own (a key it holds),
 * then its receipt, read through the chain's connection until it is mined.
 *
 * - `sending`: the signer signs and sends it once the chain's connection can
 *   take a call, waiting in `sending` until then; one send per entry. Its
 *   outcomes: `sent` with the transaction's hash, to `loading`; the
 *   contract reverted it at gas estimation, to `refused` with the revert's
 *   name (e.g. `PauseNotNewer`); any other failure (the signer's node
 *   unreachable, a nonce clash), to `sendFailed` with the error.
 * - `refused` and `sendFailed` send again only on `send()`: a refusal is the
 *   contract's answer, and a transaction the node may hold is never sent
 *   twice by itself.
 * - From `loading` on, the receipt is read through the chain's connection,
 *   and again on each new block until the transaction is mined; `current`
 *   holds it, `receipt.status` 1 for success and 0 for a revert.
 * - `closed` is terminal.
 */
export const SignerTransactionGraph = define({
    nodes: {
        sending: {},
        refused: { errorName: '' },
        sendFailed: { error: '' },
        ...nodes,
    },
    edges: {
        sent: { from: 'sending', to: 'loading', on: 'sent.next' },
        contractRefused: { from: 'sending', to: 'refused', on: 'refused.next' },
        failedToSend: { from: 'sending', to: 'sendFailed', on: 'sendFailed.next' },
        sendAgainAfterRefusal: { from: 'refused', to: 'sending', on: 'send.next' },
        sendAgainAfterFailure: { from: 'sendFailed', to: 'sending', on: 'send.next' },
        closedWhileSending: { from: 'sending', to: 'closed', on: 'close.next' },
        closedAfterRefusal: { from: 'refused', to: 'closed', on: 'close.next' },
        closedAfterSendFailed: { from: 'sendFailed', to: 'closed', on: 'close.next' },
        ...edges,
    },
});

/** The signer transaction's state: a node of the graph and its data. */
export type SignerTransactionState = StateUnion<typeof SignerTransactionGraph.nodes>;
