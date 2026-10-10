import { NEVER, of, throwError } from 'rxjs';
import { createWalletTransactionMachine, type WalletCall } from '../../rpc/connection/walletTransaction.impl.js';
import {
    createContiguousBatches,
    createFakeEthereumProvider,
    createFakeTempoProvider,
    createFakeWallet,
    createTestConnections,
    statesDuring,
    waitForNode,
    TARGET_A,
    transactionHashOf,
} from '../testUtils.js';

/** A transaction the fake Ethereum node has mined, at block 100. */
const MINED = transactionHashOf(0n);

/** The error a wallet gives when the user says no. */
const rejected = () => Object.assign(new Error('User rejected the request.'), { code: 'ACTION_REJECTED' });

/** Both chains, connected, with a wallet on Ethereum whose machine starts at `walletNode`. */
async function setUp(walletNode = 'ready') {
    const fake = createFakeWallet(walletNode);
    const ethereum = createFakeEthereumProvider([{ requestId: 0n, blockNumber: 100, target: TARGET_A }], {
        latestBlock: 200,
    });
    const tempo = createFakeTempoProvider(createContiguousBatches([]));
    const test = createTestConnections(ethereum.provider, tempo.provider, fake.wallet);
    await Promise.all([
        waitForNode(test.connections.ethereum.http.connection, 'ready'),
        waitForNode(test.connections.tempo.http.connection, 'ready'),
    ]);
    return { ...fake, ...test };
}

describe('wallet transaction machine', () => {
    test('asks the wallet to sign, then follows the receipt until it is mined', async () => {
        const { connections, signer, close } = await setUp();
        const signedWith: unknown[] = [];
        const call: WalletCall = (walletSigner) => {
            signedWith.push(walletSigner);
            return of({ hash: MINED });
        };
        const transaction = createWalletTransactionMachine(connections, 'ethereum', call);

        const mined = await waitForNode(transaction, 'current');
        expect(mined.data).toEqual(
            expect.objectContaining({ transactionHash: MINED, receipt: expect.objectContaining({ status: 1 }) })
        );
        expect(signedWith).toEqual([signer]);
        transaction.close();
        close();
    });

    test('waits for the wallet to be ready before asking', async () => {
        const { connections, state$, close } = await setUp('wrongNetwork');
        let asked = 0;
        const transaction = createWalletTransactionMachine(connections, 'ethereum', () => {
            asked++;
            return of({ hash: MINED });
        });

        const waiting = (await statesDuring(transaction, 50)).map(({ node }) => node);
        expect(new Set(waiting)).toEqual(new Set(['waitingForWallet']));
        expect(asked).toBe(0);
        state$.next({ node: 'ready', data: {} });
        await waitForNode(transaction, 'current');
        expect(asked).toBe(1);
        transaction.close();
        close();
    });

    test('a declined request is asked again only on send()', async () => {
        const { connections, close } = await setUp();
        let asked = 0;
        const transaction = createWalletTransactionMachine(connections, 'ethereum', () =>
            ++asked === 1 ? throwError(rejected) : of({ hash: MINED })
        );

        await waitForNode(transaction, 'declined');
        const declined = (await statesDuring(transaction, 50)).map(({ node }) => node);
        expect(new Set(declined)).toEqual(new Set(['declined']));
        expect(asked).toBe(1);
        transaction.send();
        await waitForNode(transaction, 'current');
        expect(asked).toBe(2);
        transaction.close();
        close();
    });

    test('a request the wallet or the contract refuses holds the error', async () => {
        const { connections, close } = await setUp();
        const transaction = createWalletTransactionMachine(connections, 'ethereum', () =>
            throwError(() => new Error('execution reverted'))
        );

        const failed = await waitForNode(transaction, 'sendFailed');
        expect(failed.data).toEqual({ error: expect.stringContaining('execution reverted') });
        transaction.close();
        close();
    });

    test('the wallet dropping while asking fails the request, which is not sent again by itself', async () => {
        const { connections, state$, close } = await setUp();
        let asked = 0;
        const transaction = createWalletTransactionMachine(connections, 'ethereum', () => {
            asked++;
            return NEVER;
        });

        await waitForNode(transaction, 'askingToSign');
        state$.next({ node: 'unreachable', data: {} });
        const failed = await waitForNode(transaction, 'sendFailed');
        expect(failed.data).toEqual({ error: expect.stringContaining('disconnected') });
        state$.next({ node: 'ready', data: {} });
        const failedStill = (await statesDuring(transaction, 50)).map(({ node }) => node);
        expect(new Set(failedStill)).toEqual(new Set(['sendFailed']));
        expect(asked).toBe(1);
        transaction.close();
        close();
    });
});
