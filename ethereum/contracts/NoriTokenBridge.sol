// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {NoriProofRequestQueue} from "./NoriProofRequestQueue.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title NoriTokenBridge
/// @dev In production the `bridgeOperator` is expected to be an OpenZeppelin
///      TimelockController (deployed via tasks/deployTimelock.ts), whose
///      proposer role is held by a Safe multisig. Admin actions therefore
///      flow as: Safe -> propose -> Timelock (delay) -> bridge admin call.
///      This contract does not implement multisig or timelock logic
///      internally — it trusts a single `bridgeOperator` address and
///      delegates governance to the Timelock + Safe stack above it.
///      Fees are collected on lock operations and are withdrawable by a
///      separate `feeRecipient` address (treasury).
///
///      Every lock enqueues a storage-proof request on `proofQueue`, which
///      orders the deposit: it must be covered by some consensus proof
///      before any later deposit can be — but not necessarily the *next*
///      proof. The lock fee is two
///      parts added together: the queue's flat per-request fee, forwarded to
///      the queue, plus `lockFeeRate` applied to the deposit, which is the
///      only part the treasury keeps. `previewLock` quotes both.
///
///      ERC-20s lock the same way through `lockERC20`, each mirrored on Tempo
///      by its own TIP-20: the deposit is credited in bridge units to
///      `lockedERC20[token][codeChallenge]`, the queue fee is paid in ETH and
///      the rate fee is kept in the token. `syncPause` copies a token's
///      `paused()` into `pauseState[token]` and requests a proof of it, so
///      the token's pause follows it to its Tempo mirror.
contract NoriTokenBridge is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------
    // Constants
    // -------------------------------
    uint8 public constant DECIMALS = 6;
    // 64-bit magnitude. This cap is also what the Tempo side relies on:
    // the bridge contract's `mint` converts the proven `lockedTokens` word to
    // a uint64 token amount, sound only because every such word (and
    // totalLockedBU, their sum) stays below 2^64.
    uint256 public constant MAX_MAGNITUDE = (1 << 64) - 1;
    uint256 public constant WEI_PER_BRIDGE_UNIT = 10 ** (18 - DECIMALS); // smallest bridge unit (BU) in wei

    uint16 public constant MAX_FEE_RATE = 10_000; // 10% hard cap (1 unit = 0.001%)
    uint32 public constant FEE_DENOMINATOR = 100_000;
    uint256 public constant MIN_FEE_BU = 10;
    /// @notice Smallest deposit `lockTokens` accepts.
    /// @dev Independent of the queue fee: a deposit must also leave something
    ///      after fees, which `FeeExceedsLockAmount` enforces separately.
    uint256 public constant MIN_LOCK_AMOUNT_WEI = 1000 * WEI_PER_BRIDGE_UNIT; // 0.001 ETH minimum deposit
    /// @notice Storage slot index of `lockedTokens`, used to derive the
    ///         storage key enqueued with each deposit.
    /// @dev `ReentrancyGuard._status` occupies slot 0 and `bridgeOperator`
    ///      slot 1, which puts `lockedTokens` at slot 2. Reordering the state
    ///      variables declared above `lockedTokens` changes this index and
    ///      would mislabel every enqueued request.
    uint256 internal constant LOCKED_TOKENS_SLOT_INDEX = 2;
    /// @notice Storage slot index of `lockedERC20`, after the fee state.
    uint256 internal constant LOCKED_ERC20_SLOT_INDEX = 6;
    /// @notice Storage slot index of `pauseState`.
    uint256 internal constant PAUSE_STATE_SLOT_INDEX = 8;
    /// @notice The first collection key of every pause request. A deposit's
    ///         first key is its codeChallenge, which `lockERC20` rejects
    ///         when it equals this, so a deposit can never pass for a pause.
    bytes32 public constant PAUSE_KEY = keccak256("NORI_PAUSE_STATE");
    /// @notice `pauseState` of a token last synced unpaused. Both states are
    ///         nonzero, so a slot never synced (zero) proves neither.
    uint256 public constant PAUSE_STATE_UNPAUSED = 1;
    /// @notice `pauseState` of a token last synced paused.
    uint256 public constant PAUSE_STATE_PAUSED = 2;
    // -------------------------------
    // Custom Errors
    // -------------------------------
    error ZeroAddress();
    error NotBridgeOperator();
    error BelowMinLockAmount();
    error InvalidBridgeUnitMultiple();
    error TotalLockedOverflow();
    error EthTransferFailed();
    error FeeRateTooHigh();
    error NotFeeRecipient();
    error FeeRecipientNotSet();
    error NoFeesToWithdraw();
    error FeeExceedsLockAmount();
    error GranularityMismatch();
    error UnlockNotSupported();
    error ReservedCodeChallenge();
    error UnsupportedTokenDecimals(uint8 decimals);
    error InvalidTokenUnitMultiple(uint256 amount, uint256 tokenUnit);
    error TransferAmountMismatch(uint256 amount, uint256 received);
    error QueueFeeMismatch(uint256 sent, uint256 queueFee);
    error TokenNotPausable(address token);

    // -------------------------------
    // State Variables
    // -------------------------------
    address public bridgeOperator;

    // lifetimeLockedByDepositor
    // Tempo recipient commitment (sha256 of the 20-byte address) -> Bridge units locked amount
    mapping(uint256 => uint256) public lockedTokens;

    // Total locked supply in bridge units
    uint256 public totalLockedBU;

    /// @notice Queue this bridge enqueues its deposit storage-proof requests on.
    /// @dev No setter: the bridge pins the same queue address at its own
    ///      deploy time, so both sides move together or not at all. Immutable
    ///      also keeps it out of storage, leaving `lockedTokens` at slot 2.
    NoriProofRequestQueue public immutable proofQueue;
    // -------------------------------
    // Fee State
    // -------------------------------
    address public feeRecipient;
    uint16 public lockFeeRate;
    uint256 public accumulatedFees;

    // -------------------------------
    // ERC-20 State
    // -------------------------------
    // Storage layout, after the fee state: slot 6 `lockedERC20`, slot 7
    // `totalLockedERC20BU`, slot 8 `pauseState`, slot 9
    // `accumulatedTokenFees`.

    /// @notice ERC-20 token -> Tempo recipient commitment -> bridge units locked.
    mapping(address => mapping(uint256 => uint256)) public lockedERC20;
    /// @notice ERC-20 token -> its total locked supply in bridge units.
    mapping(address => uint256) public totalLockedERC20BU;
    /// @notice ERC-20 token -> its last synced pause state
    ///         (`PAUSE_STATE_UNPAUSED` or `PAUSE_STATE_PAUSED`).
    mapping(address => uint256) public pauseState;
    /// @notice ERC-20 token -> rate fees kept, in the token's own units.
    mapping(address => uint256) public accumulatedTokenFees;

    // -------------------------------
    // Events
    // -------------------------------
    event TokensLocked(
        address indexed user,
        uint256 indexed codeChallenge,
        uint256 amount,
        uint256 fee
    );

    /// @notice `amount` of `token` locked for `codeChallenge`, net of `fee`,
    ///         both in the token's own units.
    event ERC20Locked(
        address indexed user,
        address indexed token,
        uint256 indexed codeChallenge,
        uint256 amount,
        uint256 fee
    );
    event PauseSynced(address indexed token, bool paused);
    event TokenFeesWithdrawn(
        address indexed recipient,
        address indexed token,
        uint256 amount
    );

    event BridgeOperatorSet(
        address indexed oldOperator,
        address indexed newOperator
    );
    event LockFeeRateSet(uint16 oldRate, uint16 newRate);
    event FeeRecipientSet(
        address indexed oldRecipient,
        address indexed newRecipient
    );
    event FeesWithdrawn(address indexed recipient, uint256 amount);

    // -------------------------------
    // Modifiers
    // -------------------------------
    modifier onlyBridgeOperator() {
        if (msg.sender != bridgeOperator) revert NotBridgeOperator();
        _;
    }

    // -------------------------------
    // Constructor
    // -------------------------------
    /// @param _bridgeOperator The admin address (expected to be a Safe in production).
    /// @param _proofQueueAddr NoriProofRequestQueue address. Immutable once set.
    /// @param _feeRecipient Initial treasury address that will receive accumulated fees.
    ///        Pass `address(0)` to defer; it can be configured later via `setFeeRecipient`.
    constructor(
        address _bridgeOperator,
        address _proofQueueAddr,
        address _feeRecipient
    ) {
        assert(DECIMALS < 18);
        if (_bridgeOperator == address(0) || _proofQueueAddr == address(0))
            revert ZeroAddress();
        bridgeOperator = _bridgeOperator;

        proofQueue = NoriProofRequestQueue(payable(_proofQueueAddr));
        // _splitFee assumes WEI_PER_BRIDGE_UNIT divides the queue's fee
        // granularity exactly, verify this on deployment against the deployed queue.
        if (
            proofQueue.PROOF_REQUEST_QUEUE_FEE_GRANULARITY_WEI() %
                WEI_PER_BRIDGE_UNIT !=
            0
        ) revert GranularityMismatch();

        if (_feeRecipient != address(0)) {
            feeRecipient = _feeRecipient;
            emit FeeRecipientSet(address(0), _feeRecipient);
        }
    }
    // -------------------------------
    // Lock ETH for a Tempo account
    // -------------------------------
    // codeChallenge is sha256 of the Tempo recipient's 20-byte address
    function lockTokens(uint256 codeChallenge) external payable {
        // ===============================
        // VALIDATION
        // ===============================
        if (msg.value < MIN_LOCK_AMOUNT_WEI) revert BelowMinLockAmount();
        if (msg.value % WEI_PER_BRIDGE_UNIT != 0)
            revert InvalidBridgeUnitMultiple();

        uint256 queueFeeWei = proofQueue.proofRequestQueueFee();

        // ===============================
        // FEE DEDUCTION (in bridge units)
        // ===============================
        uint256 grossBU = msg.value / WEI_PER_BRIDGE_UNIT;
        (uint256 feeBU, uint256 netBU) = _splitFee(grossBU, queueFeeWei);
        uint256 feeWei = feeBU * WEI_PER_BRIDGE_UNIT;

        // Ensure total locked supply does not exceed MAX_MAGNITUDE
        if (totalLockedBU + netBU > MAX_MAGNITUDE) revert TotalLockedOverflow();

        // ===============================
        // LOCK LOGIC (bridge units internally)
        // ===============================
        lockedTokens[codeChallenge] += netBU;
        totalLockedBU += netBU;
        // The treasury keeps only the rate portion
        accumulatedFees += feeWei - queueFeeWei;

        // ===============================
        // PROOF REQUEST
        // slotKey and collectionKeys are both derived from codeChallenge here,
        // so the pairing cannot be forged by the caller.
        // ===============================
        bytes32 slotKey = keccak256(
            abi.encode(codeChallenge, LOCKED_TOKENS_SLOT_INDEX)
        );
        bytes32[] memory collectionKeys = new bytes32[](1);
        collectionKeys[0] = bytes32(codeChallenge);
        proofQueue.requestProof{value: queueFeeWei}(slotKey, collectionKeys);

        emit TokensLocked(
            msg.sender,
            codeChallenge,
            netBU * WEI_PER_BRIDGE_UNIT,
            feeWei
        );
    }

    /// @notice Quote what a deposit of `grossAmount` wei would cost and lock.
    /// @dev The inverse of `calcGrossLockAmount`. Reverts on any amount
    ///      `lockTokens` would reject — except `TotalLockedOverflow`, which
    ///      depends on the cumulative locked supply rather than the quoted
    ///      amount (and is unreachable at any realistic supply).
    /// @param grossAmount The msg.value the caller intends to send.
    /// @return feeWei Total fee: the flat queue fee plus the rate portion.
    /// @return netWei Amount that would be credited to the codeChallenge.
    function previewLock(
        uint256 grossAmount
    ) external view returns (uint256 feeWei, uint256 netWei) {
        if (grossAmount < MIN_LOCK_AMOUNT_WEI) revert BelowMinLockAmount();
        if (grossAmount % WEI_PER_BRIDGE_UNIT != 0)
            revert InvalidBridgeUnitMultiple();

        (uint256 feeBU, uint256 netBU) = _splitFee(
            grossAmount / WEI_PER_BRIDGE_UNIT,
            proofQueue.proofRequestQueueFee()
        );
        feeWei = feeBU * WEI_PER_BRIDGE_UNIT;
        netWei = netBU * WEI_PER_BRIDGE_UNIT;
    }

    /// @dev Shared by `lockTokens` and `previewLock` so a quote cannot
    ///      disagree with what the deposit is charged.
    function _splitFee(
        uint256 grossBU,
        uint256 queueFeeWei
    ) internal view returns (uint256 feeBU, uint256 netBU) {
        // Exact: the queue only accepts a bridge-unit-aligned fee
        feeBU = (queueFeeWei / WEI_PER_BRIDGE_UNIT) + _rateFeeBU(grossBU);
        // A deposit must never be consumed entirely by its own fee
        if (feeBU >= grossBU) revert FeeExceedsLockAmount();

        netBU = grossBU - feeBU;
    }

    /// @dev The `lockFeeRate` part of a deposit's fee, in bridge units.
    function _rateFeeBU(uint256 grossBU) internal view returns (uint256 rateFeeBU) {
        // Rounds down to whole bridge units (bounded by the floor below)
        rateFeeBU = (grossBU * lockFeeRate) / FEE_DENOMINATOR;
        // Floor, not a round-up: charge at least MIN_FEE_BU when a rate is
        // configured (worst case the treasury gets ~9.1% under the exact fee)
        if (lockFeeRate > 0 && rateFeeBU < MIN_FEE_BU) rateFeeBU = MIN_FEE_BU;
    }

    /// @notice Always reverts. The bridge is one-way (ETH -> Tempo); no
    ///         unlock path exists.
    function unlockTokens() external pure {
        revert UnlockNotSupported();
    }

    // -------------------------------
    // Lock an ERC-20 for a Tempo account
    // -------------------------------
    /// @notice Locks `amount` of `token` for the Tempo account whose address
    ///         hashes (sha256) to `codeChallenge`; its Tempo mirror mints the
    ///         net amount there.
    /// @dev `msg.value` pays the queue fee exactly. The rate fee is taken in
    ///      the token. `amount` must be a whole number of bridge units
    ///      (10^(decimals - 6) of the token's units), and the token must move
    ///      exactly `amount` (no fee-on-transfer tokens).
    ///      The proven leaf is `[codeChallenge, token]` -> bridge units locked
    ///      so far, read from `lockedERC20[token][codeChallenge]`.
    /// @param token The ERC-20; the caller must have approved `amount`.
    /// @param amount The amount to lock, in the token's own units.
    /// @param codeChallenge sha256 of the Tempo recipient's 20-byte address.
    function lockERC20(
        address token,
        uint256 amount,
        uint256 codeChallenge
    ) external payable nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (bytes32(codeChallenge) == PAUSE_KEY) revert ReservedCodeChallenge();

        uint256 queueFeeWei = proofQueue.proofRequestQueueFee();
        if (msg.value != queueFeeWei) revert QueueFeeMismatch(msg.value, queueFeeWei);

        uint256 tokenUnit = _tokenUnit(token);
        if (amount % tokenUnit != 0) revert InvalidTokenUnitMultiple(amount, tokenUnit);
        (uint256 feeBU, uint256 netBU) = _splitTokenFee(amount / tokenUnit);
        if (totalLockedERC20BU[token] + netBU > MAX_MAGNITUDE) revert TotalLockedOverflow();

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert TransferAmountMismatch(amount, received);

        lockedERC20[token][codeChallenge] += netBU;
        totalLockedERC20BU[token] += netBU;
        accumulatedTokenFees[token] += feeBU * tokenUnit;

        // slotKey and collectionKeys are both derived here, so the pairing
        // cannot be forged by the caller
        bytes32 slotKey = keccak256(
            abi.encode(
                codeChallenge,
                keccak256(abi.encode(token, LOCKED_ERC20_SLOT_INDEX))
            )
        );
        bytes32[] memory collectionKeys = new bytes32[](2);
        collectionKeys[0] = bytes32(codeChallenge);
        collectionKeys[1] = bytes32(uint256(uint160(token)));
        proofQueue.requestProof{value: queueFeeWei}(slotKey, collectionKeys);

        emit ERC20Locked(
            msg.sender,
            token,
            codeChallenge,
            netBU * tokenUnit,
            feeBU * tokenUnit
        );
    }

    /// @notice Quote a `lockERC20` of `amount` of `token`.
    /// @return queueFeeWei The ETH `lockERC20` must be sent with.
    /// @return fee The rate fee, in the token's own units.
    /// @return net The amount that would be credited, in the token's own units.
    function previewLockERC20(
        address token,
        uint256 amount
    ) external view returns (uint256 queueFeeWei, uint256 fee, uint256 net) {
        uint256 tokenUnit = _tokenUnit(token);
        if (amount % tokenUnit != 0) revert InvalidTokenUnitMultiple(amount, tokenUnit);
        (uint256 feeBU, uint256 netBU) = _splitTokenFee(amount / tokenUnit);
        queueFeeWei = proofQueue.proofRequestQueueFee();
        fee = feeBU * tokenUnit;
        net = netBU * tokenUnit;
    }

    /// @notice Copies `token`'s `paused()` into `pauseState[token]` and
    ///         requests a proof of it, so its Tempo mirror follows. Anyone
    ///         may call it; `msg.value` pays the queue fee exactly.
    /// @dev The proven leaf is `[PAUSE_KEY, token]` -> `pauseState[token]`.
    ///      The proof reads the slot at its own Ethereum block, so the newest
    ///      batch carries the newest state.
    function syncPause(address token) external payable nonReentrant {
        uint256 queueFeeWei = proofQueue.proofRequestQueueFee();
        if (msg.value != queueFeeWei) revert QueueFeeMismatch(msg.value, queueFeeWei);

        (bool ok, bytes memory result) = token.staticcall(
            abi.encodeWithSignature("paused()")
        );
        if (!ok || result.length != 32) revert TokenNotPausable(token);
        bool paused = abi.decode(result, (bool));
        pauseState[token] = paused ? PAUSE_STATE_PAUSED : PAUSE_STATE_UNPAUSED;

        bytes32 slotKey = keccak256(abi.encode(token, PAUSE_STATE_SLOT_INDEX));
        bytes32[] memory collectionKeys = new bytes32[](2);
        collectionKeys[0] = PAUSE_KEY;
        collectionKeys[1] = bytes32(uint256(uint160(token)));
        proofQueue.requestProof{value: queueFeeWei}(slotKey, collectionKeys);

        emit PauseSynced(token, paused);
    }

    /// @dev One bridge unit of `token`, in its own units: 10^(decimals - 6).
    ///      Tokens with fewer than 6 decimals are not supported.
    function _tokenUnit(address token) internal view returns (uint256) {
        uint8 tokenDecimals = IERC20Metadata(token).decimals();
        if (tokenDecimals < DECIMALS || tokenDecimals > 36)
            revert UnsupportedTokenDecimals(tokenDecimals);
        return 10 ** (tokenDecimals - DECIMALS);
    }

    /// @dev An ERC-20 deposit's fee and net, in bridge units: only the rate
    ///      part, as the queue fee is paid in ETH.
    function _splitTokenFee(
        uint256 grossBU
    ) internal view returns (uint256 feeBU, uint256 netBU) {
        feeBU = _rateFeeBU(grossBU);
        if (feeBU >= grossBU) revert FeeExceedsLockAmount();
        netBU = grossBU - feeBU;
    }

    // -------------------------------
    // Admin: Operator Rotation
    // -------------------------------
    /// @notice Rotate the bridge operator to a new address.
    /// @dev Allows migration from one Safe to another without redeploying.
    /// @param newOperator The new bridge operator address.
    function setBridgeOperator(
        address newOperator
    ) external onlyBridgeOperator {
        if (newOperator == address(0)) revert ZeroAddress();

        address oldOperator = bridgeOperator;
        bridgeOperator = newOperator;

        emit BridgeOperatorSet(oldOperator, newOperator);
    }

    // -------------------------------
    // Admin: Fee Configuration
    // -------------------------------
    /// @notice Set the fee rate for lock operations.
    /// @param newRate Fee rate (1 unit = 0.001%, max 10000 = 10%).
    function setLockFeeRate(uint16 newRate) external onlyBridgeOperator {
        if (newRate > MAX_FEE_RATE) revert FeeRateTooHigh();

        uint16 oldRate = lockFeeRate;
        lockFeeRate = newRate;

        emit LockFeeRateSet(oldRate, newRate);
    }

    /// @notice Set the fee recipient (treasury) address.
    /// @param newRecipient Address that will receive accumulated fees via withdrawFees().
    function setFeeRecipient(address newRecipient) external onlyBridgeOperator {
        if (newRecipient == address(0)) revert ZeroAddress();

        address oldRecipient = feeRecipient;
        feeRecipient = newRecipient;

        emit FeeRecipientSet(oldRecipient, newRecipient);
    }

    /// @notice Withdraw accumulated protocol fees to the fee recipient.
    /// @dev Only callable by the feeRecipient. Uses CEI pattern + nonReentrant.
    function withdrawFees() external nonReentrant {
        if (feeRecipient == address(0)) revert FeeRecipientNotSet();
        if (msg.sender != feeRecipient) revert NotFeeRecipient();

        uint256 fees = accumulatedFees;
        if (fees == 0) revert NoFeesToWithdraw();

        // Effects before interaction
        accumulatedFees = 0;

        (bool ok, ) = payable(feeRecipient).call{value: fees}("");
        if (!ok) revert EthTransferFailed();

        emit FeesWithdrawn(feeRecipient, fees);
    }

    /// @notice Withdraw the rate fees kept in `token` to the fee recipient.
    /// @dev Only callable by the feeRecipient, as `withdrawFees`.
    function withdrawTokenFees(address token) external nonReentrant {
        if (feeRecipient == address(0)) revert FeeRecipientNotSet();
        if (msg.sender != feeRecipient) revert NotFeeRecipient();

        uint256 fees = accumulatedTokenFees[token];
        if (fees == 0) revert NoFeesToWithdraw();

        // Effects before interaction
        accumulatedTokenFees[token] = 0;
        IERC20(token).safeTransfer(feeRecipient, fees);

        emit TokenFeesWithdrawn(feeRecipient, token, fees);
    }
    receive() external payable {
        revert("Use lockTokens to lock Ether");
    }
    // -------------------------------
    // View Helper: compute gross lock amount for a desired net
    // -------------------------------
    /// @notice Compute the msg.value needed to lock a desired net amount after fees.
    /// @dev The returned grossAmount is clamped to at least MIN_LOCK_AMOUNT_WEI so it
    ///      will always pass lockTokens() validation. If the caller's desiredNetAmount
    ///      is tiny, actualNetAmount may exceed it due to the minimum gross constraint.
    ///      Covers both fee parts: the flat queue fee and the rate.
    /// @param desiredNetAmount The net amount (in wei) the caller wants locked.
    /// @return grossAmount The msg.value to send (includes fee).
    /// @return fee The fee portion that will be deducted.
    /// @return actualNetAmount The actual net amount that will be locked (in wei).
    function calcGrossLockAmount(
        uint256 desiredNetAmount
    )
        external
        view
        returns (uint256 grossAmount, uint256 fee, uint256 actualNetAmount)
    {
        uint256 queueFeeWei = proofQueue.proofRequestQueueFee();
        uint256 queueFeeBU = queueFeeWei / WEI_PER_BRIDGE_UNIT;

        // Round desired net up to bridge units
        uint256 desiredNetBU = (desiredNetAmount + WEI_PER_BRIDGE_UNIT - 1) /
            WEI_PER_BRIDGE_UNIT;

        // The queue fee is flat, so it raises the target the rate is solved against
        uint256 targetBU = desiredNetBU + queueFeeBU;

        uint256 grossBU;

        if (lockFeeRate == 0) {
            grossBU = targetBU;
        } else {
            // Ceiling division so resulting net is at least desiredNetBU
            uint256 denominator = FEE_DENOMINATOR - lockFeeRate;
            grossBU =
                (targetBU * FEE_DENOMINATOR + denominator - 1) /
                denominator;

            uint256 rateFeeBU0 = (grossBU * lockFeeRate) / FEE_DENOMINATOR;
            if (rateFeeBU0 < MIN_FEE_BU) {
                grossBU = targetBU + MIN_FEE_BU;
            }
        }

        // Enforce minimum gross deposit (mirrors lockTokens validation)
        uint256 minGrossBU = MIN_LOCK_AMOUNT_WEI / WEI_PER_BRIDGE_UNIT;
        if (grossBU < minGrossBU) {
            grossBU = minGrossBU;
        }

        // Recompute fee from actual grossBU so result exactly matches lockTokens()
        uint256 rateFeeBU = (grossBU * lockFeeRate) / FEE_DENOMINATOR;
        if (lockFeeRate > 0 && rateFeeBU < MIN_FEE_BU) {
            rateFeeBU = MIN_FEE_BU;
        }

        uint256 feeBU = queueFeeBU + rateFeeBU;
        uint256 netBU = grossBU - feeBU;

        grossAmount = grossBU * WEI_PER_BRIDGE_UNIT;
        fee = feeBU * WEI_PER_BRIDGE_UNIT;
        actualNetAmount = netBU * WEI_PER_BRIDGE_UNIT;
    }
}
