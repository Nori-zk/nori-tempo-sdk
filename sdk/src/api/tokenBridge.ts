import { type ContractRunner, type ContractTransactionReceipt } from 'ethers';
import { forCalls, type Tempo } from '../rpc/connection/connections.js';
import { fetchErc20MintedSoFar, fetchErc20TotalMinted, fetchMintedSoFar } from '../rpc/tempo/fetchMintedSoFar.js';
import { fetchLastPauseApplied, fetchMirror, type LastPauseApplied } from '../rpc/tempo/fetchMirror.js';
import { fetchFeeToken, fetchTokenBalance, fetchTokenPaused } from '../rpc/tempo/fetchTokenBalance.js';
import { sendApplyPause, sendMint, sendMintERC20 } from '../rpc/tempo/tokenBridgeTransactions.js';
import { type VerifiedRequestWitness } from '../proofRequest/getProofRequestStateSnapshot.js';

export { TempoTransactionRevertedError } from '../rpc/tempo/tokenBridgeTransactions.js';
export type { LastPauseApplied };

/**
 * How much of the bridged token (nETH) a recipient has minted so far.
 *
 * @param tempo The Tempo chain.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param recipient The Tempo address the deposits committed to.
 * @returns The amount, in the token's units.
 */
export function getMintedSoFar(tempo: Tempo, bridgeAddress: string, recipient: string): Promise<bigint> {
    return forCalls(tempo, fetchMintedSoFar, bridgeAddress, recipient);
}

/**
 * How much of an Ethereum ERC-20's mirror a recipient has minted so far.
 *
 * @param tempo The Tempo chain.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param ethToken The Ethereum ERC-20.
 * @param recipient The Tempo address the deposits committed to.
 * @returns The amount, in the mirror's units.
 */
export function getErc20MintedSoFar(
    tempo: Tempo,
    bridgeAddress: string,
    ethToken: string,
    recipient: string
): Promise<bigint> {
    return forCalls(tempo, fetchErc20MintedSoFar, bridgeAddress, ethToken, recipient);
}

/**
 * How much of an Ethereum ERC-20's mirror the bridge has minted, to every
 * recipient. It is never more than the ERC-20's `totalLockedERC20BU` on
 * Ethereum; the difference is locked but not claimed yet. For a mirror the
 * bridge created it is the mirror's whole supply; an issuer's own adopted
 * TIP-20 can also hold supply the issuer minted itself.
 *
 * @param tempo The Tempo chain.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param ethToken The Ethereum ERC-20.
 * @returns The amount, in the mirror's units.
 */
export function getErc20TotalMinted(tempo: Tempo, bridgeAddress: string, ethToken: string): Promise<bigint> {
    return forCalls(tempo, fetchErc20TotalMinted, bridgeAddress, ethToken);
}

/**
 * The TIP-20 mirror of an Ethereum ERC-20: one the bridge created
 * (`registerMirror`), or the issuer's own TIP-20 it adopted (`adoptMirror`).
 *
 * @param tempo The Tempo chain.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param ethToken The Ethereum ERC-20.
 * @returns The mirror's address, or `undefined` while none is registered.
 */
export function getMirror(tempo: Tempo, bridgeAddress: string, ethToken: string): Promise<string | undefined> {
    return forCalls(tempo, fetchMirror, bridgeAddress, ethToken);
}

/**
 * Which batch's pause state an ERC-20's mirror last followed.
 *
 * @param tempo The Tempo chain.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param ethToken The Ethereum ERC-20.
 * @returns Whether a pause state was applied, and its batch index when one was.
 */
export function getLastPauseApplied(
    tempo: Tempo,
    bridgeAddress: string,
    ethToken: string
): Promise<LastPauseApplied> {
    return forCalls(tempo, fetchLastPauseApplied, bridgeAddress, ethToken);
}

/**
 * An account's balance of a TIP-20: nETH, an ERC-20's mirror, or a fee token.
 *
 * @param tempo The Tempo chain.
 * @param token The TIP-20.
 * @param account The account.
 * @returns The balance, in the token's units (6 decimals).
 */
export function getTokenBalance(tempo: Tempo, token: string, account: string): Promise<bigint> {
    return forCalls(tempo, fetchTokenBalance, token, account);
}

/**
 * Whether a TIP-20 is paused. An ERC-20's mirror is paused while its last
 * applied pause state is paused; nobody can then move, mint or burn it.
 *
 * @param tempo The Tempo chain.
 * @param token The TIP-20.
 * @returns Whether it is paused.
 */
export function getTokenPaused(tempo: Tempo, token: string): Promise<boolean> {
    return forCalls(tempo, fetchTokenPaused, token);
}

/**
 * The USD TIP-20 an account chose to pay its Tempo transaction fees in.
 * With `getTokenBalance`, it tells whether the account can pay for `mint`.
 *
 * @param tempo The Tempo chain.
 * @param account The account.
 * @returns The fee token, or `undefined` when the account chose none.
 */
export function getFeeToken(tempo: Tempo, account: string): Promise<string | undefined> {
    return forCalls(tempo, fetchFeeToken, account);
}

/**
 * Mints the bridged token (nETH) to the signer against a proven ETH deposit.
 * Sign with the app's Tempo wallet (`(await tempo.wallet.ready()).getSigner()`)
 * or any ethers signer on Tempo.
 *
 * @param signer The recipient's Tempo signer, holding a fee token.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param depositWitness The deposit's witness, from `getVerifiedRequestWitness`.
 * @param proofQueueBatchIndex The committed batch holding the deposit (`proofAvailable`'s `proofQueueBatchIndex`).
 * @returns The transaction's receipt, final on Tempo.
 */
export function mint(
    signer: ContractRunner,
    bridgeAddress: string,
    depositWitness: VerifiedRequestWitness,
    proofQueueBatchIndex: bigint
): Promise<ContractTransactionReceipt> {
    return sendMint(signer, bridgeAddress, depositWitness, proofQueueBatchIndex);
}

/**
 * Mints an Ethereum ERC-20's TIP-20 mirror to the signer against a proven
 * `lockERC20` deposit.
 *
 * @param signer The recipient's Tempo signer, holding a fee token.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param depositWitness The deposit's witness, from `getVerifiedRequestWitness`.
 * @param proofQueueBatchIndex The committed batch holding the deposit.
 * @returns The transaction's receipt, final on Tempo.
 */
export function mintERC20(
    signer: ContractRunner,
    bridgeAddress: string,
    depositWitness: VerifiedRequestWitness,
    proofQueueBatchIndex: bigint
): Promise<ContractTransactionReceipt> {
    return sendMintERC20(signer, bridgeAddress, depositWitness, proofQueueBatchIndex);
}

/**
 * Pauses or unpauses an ERC-20's mirror to match its proven pause state.
 * Anyone may send it; the batch must be newer than the last one applied
 * for the token (`getLastPauseApplied`).
 *
 * @param signer Any Tempo signer holding a fee token.
 * @param bridgeAddress The `NoriTempoTokenBridge` address.
 * @param pauseWitness The pause state's witness, from `getVerifiedRequestWitness`.
 * @param proofQueueBatchIndex The committed batch holding the pause state.
 * @returns The transaction's receipt, final on Tempo.
 */
export function applyPause(
    signer: ContractRunner,
    bridgeAddress: string,
    pauseWitness: VerifiedRequestWitness,
    proofQueueBatchIndex: bigint
): Promise<ContractTransactionReceipt> {
    return sendApplyPause(signer, bridgeAddress, pauseWitness, proofQueueBatchIndex);
}
