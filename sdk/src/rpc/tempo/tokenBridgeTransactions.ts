import { type Interface } from 'ethers';
import { NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import { type VerifiedRequestWitness } from '../../proofRequest/getProofRequestStateSnapshot.js';
import { type TransactionCall } from '../../transaction/sentTransaction.impl.js';

/**
 * The bridge contract's ABI: what its calls are encoded with, and what names
 * a refusal (`errors` of `createWalletTransactionMachine` and
 * `createSignerTransactionMachine`, e.g. `PauseNotNewer`).
 */
export const tokenBridgeInterface: Interface = NoriTempoTokenBridge__factory.createInterface();

/**
 * The bridge's `mint`: the bridged token (nETH) to the sender against a
 * proven ETH deposit. The deposit committed to `sha256` of the sender's
 * address, and the bridge mints what was locked and not yet minted.
 *
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param depositWitness The deposit's witness (`verifiedWitness`, from `createProofRequestWitnessMachine`).
 * @param proofQueueBatchIndex The committed batch holding the deposit.
 * @returns The call, for `createWalletTransactionMachine` or `createSignerTransactionMachine`.
 */
export const mintCall = (
    bridgeAddress: string,
    depositWitness: VerifiedRequestWitness,
    proofQueueBatchIndex: bigint
): TransactionCall => ({
    to: bridgeAddress,
    data: tokenBridgeInterface.encodeFunctionData('mint', [depositWitness, proofQueueBatchIndex]),
    value: 0n,
});

/**
 * The bridge's `mintERC20`: an Ethereum ERC-20's TIP-20 mirror to the
 * sender against a proven `lockERC20` deposit, as `mintCall` for ETH.
 *
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param depositWitness The deposit's witness (`verifiedWitness`, from `createProofRequestWitnessMachine`).
 * @param proofQueueBatchIndex The committed batch holding the deposit.
 * @returns The call, for `createWalletTransactionMachine` or `createSignerTransactionMachine`.
 */
export const mintERC20Call = (
    bridgeAddress: string,
    depositWitness: VerifiedRequestWitness,
    proofQueueBatchIndex: bigint
): TransactionCall => ({
    to: bridgeAddress,
    data: tokenBridgeInterface.encodeFunctionData('mintERC20', [depositWitness, proofQueueBatchIndex]),
    value: 0n,
});

/**
 * The bridge's `applyPause`: an ERC-20's mirror paused or unpaused to match
 * its proven pause state (`NoriTokenBridge.syncPause` on Ethereum). Anyone
 * may send it; the batch must be newer than the last one applied for the
 * token.
 *
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param pauseWitness The pause state's witness (`verifiedWitness`, from `createProofRequestWitnessMachine`).
 * @param proofQueueBatchIndex The committed batch holding the pause state.
 * @returns The call, for `createWalletTransactionMachine` or `createSignerTransactionMachine`.
 */
export const applyPauseCall = (
    bridgeAddress: string,
    pauseWitness: VerifiedRequestWitness,
    proofQueueBatchIndex: bigint
): TransactionCall => ({
    to: bridgeAddress,
    data: tokenBridgeInterface.encodeFunctionData('applyPause', [pauseWitness, proofQueueBatchIndex]),
    value: 0n,
});
