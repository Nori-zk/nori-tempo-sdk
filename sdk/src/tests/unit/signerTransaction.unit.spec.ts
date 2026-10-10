import { type Signer } from 'ethers';
import { of, throwError } from 'rxjs';
import { createSignerTransactionMachine, type SignerCall } from '../../transaction/signerTransaction.impl.js';
import {
    createContiguousBatches,
    createFakeEthereumProvider,
    createFakeTempoProvider,
    createTestConnections,
    statesDuring,
    waitForNode,
    TARGET_A,
    transactionHashOf,
} from '../testUtils.js';

/** A transaction the fake Ethereum node has mined, at block 100. */
const MINED = transactionHashOf(0n);

/** The app's own signer, as the call receives it. */
const SIGNER = { address: TARGET_A } as unknown as Signer;

/** The error ethers gives when the contract reverts a send at gas estimation with a named error. */
const reverted = (name: string) =>
    Object.assign(new Error(`execution reverted: ${name}()`), {
        code: 'CALL_EXCEPTION',
        revert: { name, signature: `${name}()`, args: [] },
        data: '0x',
    });

/** Both chains, connected. */
async function setUp() {
    const ethereum = createFakeEthereumProvider([{ requestId: 0n, blockNumber: 100, target: TARGET_A }], {
        latestBlock: 200,
    });
    const tempo = createFakeTempoProvider(createContiguousBatches([]));
    const test = createTestConnections(ethereum.provider, tempo.provider);
    await Promise.all([
        waitForNode(test.connections.ethereum.http.connection, 'ready'),
        waitForNode(test.connections.tempo.http.connection, 'ready'),
    ]);
    return test;
}

describe('signer transaction machine', () => {
    test('sends with the signer, then follows the receipt until it is mined', async () => {
        const { connections, close } = await setUp();
        const signedWith: unknown[] = [];
        const call: SignerCall = (signer) => {
            signedWith.push(signer);
            return of({ hash: MINED });
        };
        const transaction = createSignerTransactionMachine(connections, 'ethereum', SIGNER, call);

        const mined = await waitForNode(transaction, 'current');
        expect(mined.data).toEqual(
            expect.objectContaining({ transactionHash: MINED, receipt: expect.objectContaining({ status: 1 }) })
        );
        expect(signedWith).toEqual([SIGNER]);
        transaction.close();
        close();
    });

    test('a send the contract reverts holds the revert name, and is sent again only on send()', async () => {
        const { connections, close } = await setUp();
        let sent = 0;
        const transaction = createSignerTransactionMachine(connections, 'ethereum', SIGNER, () =>
            ++sent === 1 ? throwError(() => reverted('PauseNotNewer')) : of({ hash: MINED })
        );

        const refused = await waitForNode(transaction, 'refused');
        expect(refused.data).toEqual({ errorName: 'PauseNotNewer' });
        const refusedStill = (await statesDuring(transaction, 50)).map(({ node }) => node);
        expect(new Set(refusedStill)).toEqual(new Set(['refused']));
        expect(sent).toBe(1);
        transaction.send();
        await waitForNode(transaction, 'current');
        expect(sent).toBe(2);
        transaction.close();
        close();
    });

    test('any other failure to send holds the error, and is not sent again by itself', async () => {
        const { connections, close } = await setUp();
        let sent = 0;
        const transaction = createSignerTransactionMachine(connections, 'ethereum', SIGNER, () => {
            sent++;
            return throwError(() => new Error('connect ECONNREFUSED'));
        });

        const failed = await waitForNode(transaction, 'sendFailed');
        expect(failed.data).toEqual({ error: expect.stringContaining('ECONNREFUSED') });
        const failedStill = (await statesDuring(transaction, 50)).map(({ node }) => node);
        expect(new Set(failedStill)).toEqual(new Set(['sendFailed']));
        expect(sent).toBe(1);
        transaction.close();
        close();
    });
});
