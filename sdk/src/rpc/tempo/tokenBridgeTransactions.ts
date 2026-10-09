import { type ContractRunner, type ContractTransactionReceipt, type ContractTransactionResponse } from 'ethers';
import { NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import { type VerifiedRequestWitness } from '../../proofRequest/getProofRequestStateSnapshot.js';

/** A Tempo transaction that reverted after it was sent. */
export class TempoTransactionRevertedError extends Error {
    constructor(readonly transactionHash: string) {
        super(`Tempo transaction ${transactionHash} reverted.`);
        this.name = 'TempoTransactionRevertedError';
    }
}

/**
 * Waits for a sent transaction's receipt, which on Tempo is final.
 *
 * @param sent The sent transaction.
 * @returns Its receipt.
 * @throws TempoTransactionRevertedError When it reverted.
 */
async function receiptOf(sent: ContractTransactionResponse): Promise<ContractTransactionReceipt> {
    const receipt = await sent.wait();
    if (receipt === null || receipt.status !== 1) throw new TempoTransactionRevertedError(sent.hash);
    return receipt;
}

/**
 * Mints the bridged token (nETH) to the signer against a proven ETH
 * deposit. The deposit committed to `sha256` of the signer's address, and
 * the bridge mints what was locked and not yet minted.
 *
 * @param signer The recipient's Tempo signer, holding a fee token.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param depositWitness The deposit's witness (`getVerifiedRequestWitness`).
 * @param proofQueueBatchIndex The committed batch holding the deposit.
 * @returns The transaction's receipt.
 * @throws TempoTransactionRevertedError When the transaction reverted after it was sent.
 */
export async function sendMint(
    signer: ContractRunner,
    bridgeAddress: string,
    depositWitness: VerifiedRequestWitness,
    proofQueueBatchIndex: bigint
): Promise<ContractTransactionReceipt> {
    const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, signer);
    return receiptOf(await bridge.mint(depositWitness, proofQueueBatchIndex));
}

/**
 * Mints an Ethereum ERC-20's TIP-20 mirror to the signer against a proven
 * `lockERC20` deposit, as `sendMint` does for ETH.
 *
 * @param signer The recipient's Tempo signer, holding a fee token.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param depositWitness The deposit's witness (`getVerifiedRequestWitness`).
 * @param proofQueueBatchIndex The committed batch holding the deposit.
 * @returns The transaction's receipt.
 * @throws TempoTransactionRevertedError When the transaction reverted after it was sent.
 */
export async function sendMintERC20(
    signer: ContractRunner,
    bridgeAddress: string,
    depositWitness: VerifiedRequestWitness,
    proofQueueBatchIndex: bigint
): Promise<ContractTransactionReceipt> {
    const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, signer);
    return receiptOf(await bridge.mintERC20(depositWitness, proofQueueBatchIndex));
}

/**
 * Pauses or unpauses an ERC-20's mirror to match its proven pause state
 * (`NoriTokenBridge.syncPause` on Ethereum). Anyone may send it; the batch
 * must be newer than the last one applied for the token.
 *
 * @param signer Any Tempo signer holding a fee token.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param pauseWitness The pause state's witness (`getVerifiedRequestWitness`).
 * @param proofQueueBatchIndex The committed batch holding the pause state.
 * @returns The transaction's receipt.
 * @throws TempoTransactionRevertedError When the transaction reverted after it was sent.
 */
export async function sendApplyPause(
    signer: ContractRunner,
    bridgeAddress: string,
    pauseWitness: VerifiedRequestWitness,
    proofQueueBatchIndex: bigint
): Promise<ContractTransactionReceipt> {
    const bridge = NoriTempoTokenBridge__factory.connect(bridgeAddress, signer);
    return receiptOf(await bridge.applyPause(pauseWitness, proofQueueBatchIndex));
}
