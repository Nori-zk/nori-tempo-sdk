// ETH and ERC-20 deposits minted on Tempo through the sdk, and an ERC-20's
// pause applied to its mirror, on two local nodes: an anvil fork of Ethereum
// mainnet (ETH_MAINNET_FORK_RPC_URL, or a public RPC) with real USDC, and
// `anvil --network tempo`. The contracts are the real ones; each proof queue
// batch is planted in the Tempo bridge's storage as `update` writes it,
// built from the queue's own storage with the guest's hashing.
import { randomBytes } from 'node:crypto';
import {
    AbiCoder,
    Contract,
    ContractFactory,
    type ContractTransactionResponse,
    id,
    isError,
    JsonRpcProvider,
    JsonRpcSigner,
    keccak256,
    sha256,
    toBeHex,
    Wallet,
    ZeroAddress,
    ZeroHash,
    zeroPadValue,
} from 'ethers';
import {
    combineLatest,
    defer,
    filter,
    finalize,
    firstValueFrom,
    map,
    type Observable,
    switchMap,
    take,
    timeout,
} from 'rxjs';
import {
    MIN_LOCK_AMOUNT_WEI,
    NoriProofRequestQueue__factory,
    NoriTokenBridge__factory,
    PAUSE_KEY,
    PAUSE_STATE_PAUSED,
    WEI_PER_BRIDGE_UNIT,
} from '@nori-zk/ethereum-tempo-bridge';
import {
    ISSUER_ROLE_NAME,
    ITIP20__factory,
    ITIP20Factory__factory,
    MAX_U64,
    NoriTempoTokenBridge__factory,
    PACKED_STATE_OFFSETS,
    PACKED_STATE_SLOT,
    PATH_USD_ADDRESS,
    PROOF_QUEUE_BATCH_OFFSETS,
    PROOF_QUEUE_BATCHES_SLOT,
    sp1VerifierJson,
    TIP20_FACTORY_ADDRESS,
} from '@nori-zk/tempo-token-bridge';
import { request_batch_root, type RequestLeaf } from '@nori-zk/ethereum-tempo-proof-queue-utils-glam';
import {
    applyPauseCall,
    createConnections,
    createTransactionReceiptMachine,
    createFeeTokenMachine,
    createLastPauseAppliedMachine,
    createMintedSoFarMachine,
    createMirrorMachine,
    createProofRequestStateMachine,
    createProofRequestWitnessMachine,
    createTokenBalanceMachine,
    mintCall,
    mintERC20Call,
    ProofRequestState,
    type TokenBridgeCall,
    type ProofAvailableProofRequestSnapshot,
    type ProofRequestStateNodeUnion,
} from '../../index.js';
import { startAnvil, type LocalNode } from '../localNodes.js';
import { type GraphState } from '../../utils/machines.js';

const DEFAULT_MAINNET_FORK_RPC_URL = 'https://ethereum-rpc.publicnode.com';
/** Anvil's public test key 0, funded on both nodes. */
const DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
/** The program vkey the test bridge pins; no test sends it a proof. */
const TEST_VKEY = '0x' + '01'.repeat(32);
/** Ethereum mainnet's USDC: 6 decimals, pausable by its pauser. */
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function masterMinter() view returns (address)',
    'function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)',
    'function mint(address to, uint256 amount) returns (bool)',
    'function pauser() view returns (address)',
    'function pause()',
];
/** USDC locked: 25.5, in its own units, which are bridge units (6 decimals). */
const USDC_LOCKED = 25_500_000n;

const word = (value: bigint) => toBeHex(value, 32);

/** Waits for a sent transaction to be mined and returns its hash. */
async function minedHash(sent: Promise<ContractTransactionResponse>): Promise<string> {
    const receipt = await (await sent).wait();
    if (receipt === null) throw new Error('The transaction has no receipt.');
    return receipt.hash;
}

/** The name of the Tempo bridge's custom error that revert data encodes. */
function bridgeErrorName(data: string | null | undefined): string | undefined {
    return data ? NoriTempoTokenBridge__factory.createInterface().parseError(data)?.name : undefined;
}

/** A value the test needs, failing the test when it is missing. */
function present<T>(value: T | null | undefined, what: string): T {
    if (value === null || value === undefined) throw new Error(`No ${what}.`);
    return value;
}

/**
 * The data a reading machine holds once it is `current` and `held` says it
 * is the value wanted; the machine closes after.
 *
 * @param machine The running machine, from its `create…Machine`.
 * @param held Whether the data is the value wanted (default: the first `current`).
 * @returns That data, once.
 */
const valueOnceRead$ =<TState extends GraphState>(
    machine: { state$: Observable<TState>; close(): void },
    held: (data: Extract<TState, { node: 'current' }>['data']) => boolean = () => true
) =>
    machine.state$.pipe(
        filter((state): state is Extract<TState, { node: 'current' }> => state.node === 'current'),
        map(({ data }) => data),
        filter(held),
        take(1),
        timeout(60_000),
        finalize(() => machine.close())
    );

describe('Token bridge through the sdk on local Ethereum and Tempo nodes', () => {
    let ethereumNode: LocalNode;
    let tempoNode: LocalNode;
    let ethereumProvider: JsonRpcProvider;
    let tempoProvider: JsonRpcProvider;
    let ethereumSigner: Wallet;
    let tempoSigner: Wallet;
    let connections: ReturnType<typeof createConnections>;
    let proofQueueAddress: string;
    let tokenBridgeAddress: string;
    let bridgeAddress: string;
    let nETH: string;
    const transactions = { lockTokens: '', lockERC20: '', syncPause: '' };
    const batchOutputBlocks: number[] = [];

    /** A signer for `address` on the Ethereum fork, impersonated and given ETH for gas. */
    async function impersonate(address: string) {
        await ethereumProvider.send('anvil_impersonateAccount', [address]);
        await ethereumProvider.send('anvil_setBalance', [address, toBeHex(10n ** 19n)]);
        return new JsonRpcSigner(ethereumProvider, address);
    }

    /**
     * Plants the next proof queue batch, covering every request from the
     * bridge's queue cursor to the queue's head at Ethereum block `block`,
     * as `update` writes it: the entry at `keccak256(index, 3)` and the
     * cursor and batch count in the packed state word.
     */
    async function plantNextBatch(block: number) {
        const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, tempoProvider);
        const queue = NoriProofRequestQueue__factory.connect(proofQueueAddress, ethereumProvider);
        const { queueCursor, proofQueueBatchCount } = await bridge.state();
        const head = await queue.head({ blockTag: block });
        const leaves: RequestLeaf[] = [];
        for (let requestId = queueCursor; requestId < head; requestId++) {
            const request = await queue.requests(requestId, { blockTag: block });
            const count = Number(request.collectionKeysCount);
            leaves.push({
                target: request.target,
                collectionKeysCount: count,
                collectionKeys: [...request.collectionKeys].slice(0, count),
                value: zeroPadValue(await ethereumProvider.getStorage(request.target, request.slotKey, block), 32),
            });
        }
        const setStorage = (slot: bigint, value: string) =>
            tempoProvider.send('anvil_setStorageAt', [bridgeAddress, word(slot), value]);
        const entry = BigInt(
            keccak256(AbiCoder.defaultAbiCoder().encode(['uint64', 'uint256'], [proofQueueBatchCount, PROOF_QUEUE_BATCHES_SLOT]))
        );
        await setStorage(entry, request_batch_root({ leaves }));
        await setStorage(
            entry + 1n,
            word(
                (BigInt(block) << PROOF_QUEUE_BATCH_OFFSETS.outputBlockNumber) |
                    (queueCursor << PROOF_QUEUE_BATCH_OFFSETS.inputQueueCursor) |
                    (head << PROOF_QUEUE_BATCH_OFFSETS.outputQueueCursor) |
                    (BigInt(await tempoProvider.getBlockNumber()) << PROOF_QUEUE_BATCH_OFFSETS.tempoBlockNumber)
            )
        );
        const packed = BigInt(await tempoProvider.getStorage(bridgeAddress, PACKED_STATE_SLOT));
        const replaced =
            (MAX_U64 << PACKED_STATE_OFFSETS.queueCursor) | (MAX_U64 << PACKED_STATE_OFFSETS.proofQueueBatchCount);
        await setStorage(
            PACKED_STATE_SLOT,
            word(
                (packed & ~replaced) |
                    (head << PACKED_STATE_OFFSETS.queueCursor) |
                    ((proofQueueBatchCount + 1n) << PACKED_STATE_OFFSETS.proofQueueBatchCount)
            )
        );
        batchOutputBlocks.push(block);
    }

    /** Where the request a transaction enqueued is, from its proof request machine. */
    const snapshot$ = (proofRequestTxHash: string) =>
        defer(() =>
            valueOnceRead$(createProofRequestStateMachine(connections, { proofQueueAddress, proofRequestTxHash, bridgeAddress }))
        ).pipe(map(({ snapshot }) => snapshot));

    /** The proof available snapshot, once the request's proof request machine is in `proofAvailable`. */
    const proofAvailable$ = (proofRequestTxHash: string) =>
        defer(() => {
            const machine = createProofRequestStateMachine(connections, {
                proofQueueAddress,
                proofRequestTxHash,
                bridgeAddress,
            });
            return machine.state$.pipe(
                filter(
                    (state): state is Extract<ProofRequestStateNodeUnion, { node: 'proofAvailable' }> =>
                        state.node === 'proofAvailable'
                ),
                map(({ data }) => data.snapshot),
                take(1),
                timeout(60_000),
                finalize(() => machine.close())
            );
        });

    /** The request's verified witness, from its witness machine. */
    const verifiedWitness$ = (proofAvailable: ProofAvailableProofRequestSnapshot) =>
        defer(() => valueOnceRead$(createProofRequestWitnessMachine(connections, proofQueueAddress, proofAvailable))).pipe(
            map(({ verifiedWitness }) => present(verifiedWitness, 'verified witness'))
        );

    /** How much `recipient` minted so far, of nETH or of `ethToken`'s mirror, from its machine. */
    const mintedSoFar$ = (recipient: string, ethToken?: string) =>
        defer(() => valueOnceRead$(createMintedSoFarMachine(connections, bridgeAddress, recipient, ethToken))).pipe(
            map(({ minted }) => minted)
        );

    /** An account's balance of a TIP-20, from its machine. */
    const balance$ = (token: string, account: string) =>
        defer(() => valueOnceRead$(createTokenBalanceMachine(connections, token, account))).pipe(map(({ balance }) => balance));

    /** An ERC-20's mirror, from its machine. */
    const mirror$ = (ethToken: string) =>
        defer(() => valueOnceRead$(createMirrorMachine(connections, bridgeAddress, ethToken))).pipe(
            map(({ mirror }) => present(mirror, 'mirror'))
        );

    /** The batch whose pause state an ERC-20's mirror last followed, from its machine. */
    const lastPauseApplied$ = (ethToken: string) =>
        defer(() => valueOnceRead$(createLastPauseAppliedMachine(connections, bridgeAddress, ethToken))).pipe(
            map(({ lastPauseApplied }) => lastPauseApplied)
        );

    /** The fee token an account chose, from its machine. */
    const feeToken$ = (account: string) =>
        defer(() => valueOnceRead$(createFeeTokenMachine(connections, account))).pipe(map(({ feeToken }) => feeToken));

    /** A token bridge call sent with the test's Tempo signer, then its receipt's status once mined, from its receipt machine. */
    const mined$ = (call: TokenBridgeCall) =>
        call(tempoSigner).pipe(
            switchMap((sent) =>
                valueOnceRead$(
                    createTransactionReceiptMachine(connections, 'tempo', sent.hash),
                    ({ receipt }) => receipt !== undefined
                )
            ),
            map(({ receipt }) => receipt?.status)
        );

    beforeAll(async () => {
        [ethereumNode, tempoNode] = await Promise.all([
            startAnvil(['--fork-url', process.env.ETH_MAINNET_FORK_RPC_URL || DEFAULT_MAINNET_FORK_RPC_URL]),
            startAnvil(['--network', 'tempo']),
        ]);
        ethereumProvider = new JsonRpcProvider(ethereumNode.url, undefined, { cacheTimeout: -1 });
        tempoProvider = new JsonRpcProvider(tempoNode.url, undefined, { cacheTimeout: -1 });
        ethereumSigner = new Wallet(DEV_KEY, ethereumProvider);
        tempoSigner = new Wallet(DEV_KEY, tempoProvider);
        const codeChallenge = BigInt(sha256(tempoSigner.address));

        // Ethereum: the queue and the token bridge, an ETH lock, a USDC lock, then USDC paused and synced
        const queue = await new NoriProofRequestQueue__factory(ethereumSigner).deploy(
            ethereumSigner.address,
            ZeroAddress,
            0n
        );
        proofQueueAddress = await queue.getAddress();
        const tokenBridge = await new NoriTokenBridge__factory(ethereumSigner).deploy(
            ethereumSigner.address,
            proofQueueAddress,
            ZeroAddress
        );
        tokenBridgeAddress = await tokenBridge.getAddress();
        transactions.lockTokens = await minedHash(tokenBridge.lockTokens(codeChallenge, { value: MIN_LOCK_AMOUNT_WEI }));

        const usdc = new Contract(USDC, USDC_ABI, ethereumProvider);
        const masterMinter = await impersonate(await usdc.masterMinter());
        await (await (usdc.connect(masterMinter) as Contract).configureMinter(ethereumSigner.address, USDC_LOCKED)).wait();
        await (await (usdc.connect(ethereumSigner) as Contract).mint(ethereumSigner.address, USDC_LOCKED)).wait();
        await (await (usdc.connect(ethereumSigner) as Contract).approve(tokenBridgeAddress, USDC_LOCKED)).wait();
        transactions.lockERC20 = await minedHash(tokenBridge.lockERC20(USDC, USDC_LOCKED, codeChallenge));
        const pauser = await impersonate(await usdc.pauser());
        await (await (usdc.connect(pauser) as Contract).pause()).wait();
        transactions.syncPause = await minedHash(tokenBridge.syncPause(USDC));

        // Tempo: the verifier, nETH, the bridge pinning both Ethereum contracts, and USDC's mirror
        const verifier = await new ContractFactory(sp1VerifierJson.abi, sp1VerifierJson.bytecode, tempoSigner).deploy();
        await verifier.waitForDeployment();
        const factory = ITIP20Factory__factory.connect(TIP20_FACTORY_ADDRESS, tempoSigner);
        const tokenArgs = ['nETH', 'nETH', 'ETH', PATH_USD_ADDRESS, tempoSigner.address, `0x${randomBytes(32).toString('hex')}`] as const;
        nETH = await factory.createToken.staticCall(...tokenArgs);
        await (await factory.createToken(...tokenArgs)).wait();
        const bridge = await new NoriTempoTokenBridge__factory(tempoSigner).deploy(
            await verifier.getAddress(),
            TEST_VKEY,
            nETH,
            ZeroHash,
            tokenBridgeAddress,
            proofQueueAddress
        );
        bridgeAddress = await bridge.getAddress();
        await (await ITIP20__factory.connect(nETH, tempoSigner).grantRole(id(ISSUER_ROLE_NAME), bridgeAddress)).wait();
        await (await bridge.registerMirror(USDC, 'Nori USDC', 'nUSDC', 'USD', `0x${randomBytes(32).toString('hex')}`)).wait();

        connections = createConnections({
            ethereum: { expectedChainId: (await ethereumProvider.getNetwork()).chainId, http: { rpcUrl: ethereumNode.url } },
            tempo: { expectedChainId: (await tempoProvider.getNetwork()).chainId, http: { rpcUrl: tempoNode.url } },
        });
        // Both chains connected, from their status machines
        await firstValueFrom(
            combineLatest([connections.ethereum.status.connection.state$, connections.tempo.status.connection.state$]).pipe(
                filter(([ethereum, tempo]) => ethereum.node === 'connected' && tempo.node === 'connected'),
                take(1),
                timeout(60_000)
            )
        );
    });

    afterAll(() => {
        connections?.close();
        ethereumNode?.stop();
        tempoNode?.stop();
    });

    test('a request no batch covers yet is unprocessed', async () => {
        const snapshot = await firstValueFrom(snapshot$(transactions.lockTokens));
        expect(snapshot.state).toBe(ProofRequestState.Unprocessed);
    });

    test('mints nETH against the proven ETH deposit, read by the queue in the first batch', async () => {
        // Batch 0, proven at the ETH deposit's block, holds only that deposit
        const ethDepositBlock = present(
            await ethereumProvider.getTransactionReceipt(transactions.lockTokens),
            'ETH deposit receipt'
        ).blockNumber;
        await plantNextBatch(ethDepositBlock);

        const proofAvailable = await firstValueFrom(proofAvailable$(transactions.lockTokens));
        expect(proofAvailable.proofQueueBatchIndex).toBe(0n);
        expect(proofAvailable.previousOutputBlockNumber).toBe(-1n);

        const witness = await firstValueFrom(verifiedWitness$(proofAvailable));
        expect(witness.value.target).toBe(tokenBridgeAddress);
        expect(witness.value.collectionKeysCount).toBe(1);
        expect(witness.value.collectionKeys[1]).toBe(ZeroHash);

        const lockedBU = MIN_LOCK_AMOUNT_WEI / WEI_PER_BRIDGE_UNIT;
        const mint = mintCall(bridgeAddress, witness, proofAvailable.proofQueueBatchIndex);
        expect(await firstValueFrom(mined$(mint))).toBe(1);
        expect(await firstValueFrom(mintedSoFar$(tempoSigner.address))).toBe(lockedBU);
        expect(await firstValueFrom(balance$(nETH, tempoSigner.address))).toBe(lockedBU);

        // A claim reused has nothing left to mint: the bridge refuses it
        const reused = await firstValueFrom(mint(tempoSigner)).catch((error: unknown) => error);
        expect(isError(reused, 'CALL_EXCEPTION') && bridgeErrorName(reused.data)).toBe('ZeroMintAmount');
        expect(await firstValueFrom(balance$(nETH, tempoSigner.address))).toBe(lockedBU);
    });

    test("mints USDC's mirror against the proven USDC deposit, read from logs in the next batch", async () => {
        // Batch 1, proven at the latest block, holds the USDC deposit and the pause sync
        await plantNextBatch(await ethereumProvider.getBlockNumber());

        const proofAvailable = await firstValueFrom(proofAvailable$(transactions.lockERC20));
        expect(proofAvailable.proofQueueBatchIndex).toBe(1n);
        expect(proofAvailable.previousOutputBlockNumber).toBe(BigInt(batchOutputBlocks[0]));

        const witness = await firstValueFrom(verifiedWitness$(proofAvailable));
        expect(witness.value.collectionKeys[1]).toBe(zeroPadValue(USDC, 32).toLowerCase());

        const mirror = await firstValueFrom(mirror$(USDC));
        expect(mirror).toBe(await NoriTempoTokenBridge__factory.connect(bridgeAddress, tempoProvider).mirrorOf(USDC));
        expect(await firstValueFrom(mined$(mintERC20Call(bridgeAddress, witness, proofAvailable.proofQueueBatchIndex)))).toBe(1);
        expect(await firstValueFrom(mintedSoFar$(tempoSigner.address, USDC))).toBe(USDC_LOCKED);
        expect(await firstValueFrom(balance$(mirror, tempoSigner.address))).toBe(USDC_LOCKED);
    });

    test("pauses USDC's mirror with the proven pause state", async () => {
        const proofAvailable = await firstValueFrom(proofAvailable$(transactions.syncPause));
        const witness = await firstValueFrom(verifiedWitness$(proofAvailable));
        expect(witness.value.collectionKeys[0]).toBe(PAUSE_KEY);
        expect(witness.value.value).toBe(PAUSE_STATE_PAUSED);

        expect(await firstValueFrom(lastPauseApplied$(USDC))).toEqual({ applied: false });
        expect(await firstValueFrom(mined$(applyPauseCall(bridgeAddress, witness, proofAvailable.proofQueueBatchIndex)))).toBe(1);
        const mirror = await firstValueFrom(mirror$(USDC));
        expect(await ITIP20__factory.connect(mirror, tempoProvider).paused()).toBe(true);
        expect(await firstValueFrom(lastPauseApplied$(USDC))).toEqual({
            applied: true,
            proofQueueBatchIndex: proofAvailable.proofQueueBatchIndex,
        });
    });

    test('reads the fee token an account chose, and none for an account that chose none', async () => {
        const feeToken = present(await firstValueFrom(feeToken$(tempoSigner.address)), 'fee token');
        expect(await firstValueFrom(balance$(feeToken, tempoSigner.address))).toBeGreaterThan(0n);
        expect(await firstValueFrom(feeToken$(Wallet.createRandom().address))).toBeUndefined();
    });
});
