import { define, type StateUnion } from '@yaw-rx/ystate';
import { type SubscriptionTransport } from './connections.js';

/** What every live node carries: the changes counted so far, and the transports that refused to subscribe. */
const counted = { changes: 0, unsupported: [] as SubscriptionTransport[] };

/**
 * Whether a chain has changed, for the machines to read again: a new block,
 * or a log matching a filter. Each change counts one in `changes`; nothing
 * else of a block or log is kept.
 *
 * - `subscribed`: subscribed on `transport`, the first transport in the
 *   chain's subscriptions order that is usable and not in `unsupported`.
 *   The node's first push acknowledges the subscription (`acknowledged`);
 *   each push after it is a change. Another transport becoming the first moves it
 *   there (`transportChanged`), and counts a change.
 * - A transport that refuses the subscription (a wallet without
 *   `eth_subscribe`, a node refusing the filter) joins `unsupported`
 *   (`subscriptionRefused`). A subscription that ends any other way (the
 *   socket closed, nothing to send it through) is lost
 *   (`subscriptionLost`): it polls, holding the transport in `lostOn`, and
 *   subscribes on it again only once it has been unusable and is usable
 *   again; another usable transport is subscribed on at once.
 * - `polling`: no transport can subscribe; it polls through the calls order
 *   every interval, and waits in `polling` while no transport in that order
 *   can take a call. `lastBlock` is the last block polled; the first poll
 *   only sets it. A new block is a change, or with a filter, a new block
 *   holding a matching log. After a gap longer than one log query, it moves
 *   `lastBlock` to the latest block and counts one change instead of
 *   reading the gap.
 * - The machine follows the chain once subscribed and acknowledged, or once
 *   its first poll has read the latest block. Moving between subscribing and
 *   polling counts a change once it has, as a change may fall between the two.
 * - `pollFailed`: a poll failed; it polls again after the interval, or
 *   subscribes once a transport can.
 * - It starts `polling` with no `lastBlock`, and subscribes at once when a
 *   transport can. `closed` is terminal.
 */
export const ChainChangesGraph = define({
    nodes: {
        subscribed: { ...counted, transport: 'websocket' as SubscriptionTransport, acknowledged: false },
        polling: {
            ...counted,
            lastBlock: undefined as number | undefined,
            lostOn: undefined as SubscriptionTransport | undefined,
        },
        pollFailed: {
            ...counted,
            lastBlock: undefined as number | undefined,
            lostOn: undefined as SubscriptionTransport | undefined,
            error: '',
        },
        closed: {},
    },
    edges: {
        pushed: { from: 'subscribed', to: 'subscribed', on: 'pushes.next' },
        subscriptionRefused: { from: 'subscribed', to: 'polling', on: 'pushes.error' },
        subscriptionLost: { from: 'subscribed', to: 'polling', on: 'pushes.complete' },
        transportChanged: { from: 'subscribed', to: 'subscribed', on: 'subscribable.next' },
        transportLost: { from: 'subscribed', to: 'polling', on: 'unsubscribable.next' },

        polled: { from: 'polling', to: 'polling', on: 'polls.next' },
        pollFailed: { from: 'polling', to: 'pollFailed', on: 'polls.error' },
        transportReady: { from: 'polling', to: 'subscribed', on: 'subscribable.next' },

        pollAgain: { from: 'pollFailed', to: 'polling', on: 'pollDue.next' },
        transportReadyAfterFailedPoll: { from: 'pollFailed', to: 'subscribed', on: 'subscribable.next' },

        closedWhileSubscribed: { from: 'subscribed', to: 'closed', on: 'close.next' },
        closedWhilePolling: { from: 'polling', to: 'closed', on: 'close.next' },
        closedAfterFailedPoll: { from: 'pollFailed', to: 'closed', on: 'close.next' },
    },
});

/** The chain changes machine's state: a node of the graph and its data. */
export type ChainChangesState = StateUnion<typeof ChainChangesGraph.nodes>;
