// How a local Tempo node (`anvil --network tempo`) treats a sender's nonce
// for transactions sent through ethers: what the transaction machines rely
// on to tell a transaction replaced or dropped, and to send one again with
// its original nonce so only one of the two can land.
import { isError, JsonRpcProvider, Wallet } from 'ethers';
import { startAnvil, type LocalNode } from '../localNodes.js';

/** Anvil's public test key 0, funded on the node. */
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe("A local Tempo node's nonces for transactions sent through ethers", () => {
    let tempoNode: LocalNode;
    let tempoProvider: JsonRpcProvider;
    let tempoSigner: Wallet;

    /** Mines one block with whatever is pending. */
    const mine = () => tempoProvider.send('evm_mine', []);

    beforeAll(async () => {
        tempoNode = await startAnvil(['--network', 'tempo']);
        tempoProvider = new JsonRpcProvider(tempoNode.url, undefined, { cacheTimeout: -1 });
        tempoSigner = new Wallet(DEV_KEY, tempoProvider);
    });

    afterAll(() => {
        tempoNode?.stop();
    });

    afterEach(async () => {
        await tempoProvider.send('evm_setAutomine', [true]);
    });

    test('a mined transaction moves the mined nonce past its own', async () => {
        const nonce = await tempoProvider.getTransactionCount(tempoSigner.address, 'latest');
        const sent = await tempoSigner.sendTransaction({ to: tempoSigner.address, value: 0n, nonce });
        await sent.wait();
        expect(await tempoProvider.getTransactionCount(tempoSigner.address, 'latest')).toBe(nonce + 1);
    });

    test('of two transactions with one nonce, only one lands, and the other is forgotten', async () => {
        await tempoProvider.send('evm_setAutomine', [false]);
        const nonce = await tempoProvider.getTransactionCount(tempoSigner.address, 'latest');
        const feeData = await tempoProvider.getFeeData();
        const maxFeePerGas = feeData.maxFeePerGas ?? 0n;
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? 0n;
        const first = await tempoSigner.sendTransaction({
            to: tempoSigner.address,
            value: 0n,
            nonce,
            maxFeePerGas,
            maxPriorityFeePerGas,
        });
        // The same nonce at a higher fee replaces it while it is pending.
        const second = await tempoSigner.sendTransaction({
            to: tempoSigner.address,
            value: 0n,
            nonce,
            maxFeePerGas: maxFeePerGas * 2n,
            maxPriorityFeePerGas: maxPriorityFeePerGas * 2n + 1n,
        });
        await mine();

        expect(await tempoProvider.getTransactionCount(tempoSigner.address, 'latest')).toBe(nonce + 1);
        expect(await tempoProvider.getTransactionReceipt(second.hash)).not.toBeNull();
        expect(await tempoProvider.getTransactionReceipt(first.hash)).toBeNull();
        expect(await tempoProvider.getTransaction(first.hash)).toBeNull();
    });

    test('the same nonce at the same fee is refused while the first is pending', async () => {
        await tempoProvider.send('evm_setAutomine', [false]);
        const nonce = await tempoProvider.getTransactionCount(tempoSigner.address, 'latest');
        const feeData = await tempoProvider.getFeeData();
        const fees = {
            maxFeePerGas: feeData.maxFeePerGas ?? 0n,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n,
        };
        const first = await tempoSigner.sendTransaction({ to: tempoSigner.address, value: 0n, nonce, ...fees });
        // Tempo refuses any value transfer, so the resend differs by its data.
        const resent = await tempoSigner
            .sendTransaction({ to: tempoSigner.address, value: 0n, data: '0x01', nonce, ...fees })
            .catch((error: unknown) => error);
        expect(isError(resent, 'REPLACEMENT_UNDERPRICED')).toBe(true);
        await mine();

        expect(await tempoProvider.getTransactionCount(tempoSigner.address, 'latest')).toBe(nonce + 1);
        expect(await tempoProvider.getTransactionReceipt(first.hash)).not.toBeNull();
    });
});
