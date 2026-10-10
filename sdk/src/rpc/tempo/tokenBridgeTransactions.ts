import { type ContractRunner, type ContractTransactionResponse } from 'ethers';
import { defer, type Observable } from 'rxjs';
import { NoriTempoTokenBridge__factory } from '@nori-zk/tempo-token-bridge';
import { type VerifiedRequestWitness } from '../../proofRequest/getProofRequestStateSnapshot.js';

/**
 * A token bridge transaction, given who signs it: emits the sent
 * transaction once. `createTransactionReceiptMachine` follows its receipt;
 * `createWalletTransactionMachine` sends it through the user's wallet and
 * follows its receipt.
 */
export type TokenBridgeCall = (signer: ContractRunner) => Observable<ContractTransactionResponse>;

/**
 * The bridge's `mint`: the bridged token (nETH) to the signer against a
 * proven ETH deposit. The deposit committed to `sha256` of the signer's
 * address, and the bridge mints what was locked and not yet minted.
 *
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param depositWitness The deposit's witness (`verifiedWitness`, from `createProofRequestWitnessMachine`).
 * @param proofQueueBatchIndex The committed batch holding the deposit.
 * @returns The call, for `createWalletTransactionMachine` or a signer of the app's own.
 */
export const mintCall =
    (bridgeAddress: string, depositWitness: VerifiedRequestWitness, proofQueueBatchIndex: bigint): TokenBridgeCall =>
    (signer) =>
        defer(() => NoriTempoTokenBridge__factory.connect(bridgeAddress, signer).mint(depositWitness, proofQueueBatchIndex));

/**
 * The bridge's `mintERC20`: an Ethereum ERC-20's TIP-20 mirror to the
 * signer against a proven `lockERC20` deposit, as `mintCall` for ETH.
 *
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param depositWitness The deposit's witness (`verifiedWitness`, from `createProofRequestWitnessMachine`).
 * @param proofQueueBatchIndex The committed batch holding the deposit.
 * @returns The call, for `createWalletTransactionMachine` or a signer of the app's own.
 */
export const mintERC20Call =
    (bridgeAddress: string, depositWitness: VerifiedRequestWitness, proofQueueBatchIndex: bigint): TokenBridgeCall =>
    (signer) =>
        defer(() =>
            NoriTempoTokenBridge__factory.connect(bridgeAddress, signer).mintERC20(depositWitness, proofQueueBatchIndex)
        );

/**
 * The bridge's `applyPause`: an ERC-20's mirror paused or unpaused to match
 * its proven pause state (`NoriTokenBridge.syncPause` on Ethereum). Anyone
 * may send it; the batch must be newer than the last one applied for the
 * token.
 *
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param pauseWitness The pause state's witness (`verifiedWitness`, from `createProofRequestWitnessMachine`).
 * @param proofQueueBatchIndex The committed batch holding the pause state.
 * @returns The call, for `createWalletTransactionMachine` or a signer of the app's own.
 */
export const applyPauseCall =
    (bridgeAddress: string, pauseWitness: VerifiedRequestWitness, proofQueueBatchIndex: bigint): TokenBridgeCall =>
    (signer) =>
        defer(() =>
            NoriTempoTokenBridge__factory.connect(bridgeAddress, signer).applyPause(pauseWitness, proofQueueBatchIndex)
        );
