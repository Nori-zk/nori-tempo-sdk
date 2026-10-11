// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {ISP1Verifier} from "sp1-contracts/ISP1Verifier.sol";
import {ITIP20} from "./interfaces/ITIP20.sol";
import {ITIP20Factory} from "./interfaces/ITIP20Factory.sol";

/// @title NoriTempoTokenBridge
/// @notice Nori's Ethereum state bridge on Tempo. It verifies nori-bridge-head's
///         SP1 Groth16 proofs of Ethereum's finalized state, commits each batch
///         of proven proof requests as a Merkle root, and mints the bridged
///         token against deposits proven by witness against a committed batch.
/// @dev `update` is permissionless: the only credential is a valid proof for
///      `noriBridgeVk`, and each proof must resume exactly where the bridge
///      stands (queue cursor, store hash chain) and move its head forward, so
///      no caller can skip, replay or fork history. Proof queue batches are
///      append-only, at contiguous indices from 0, recorded only for updates
///      whose batch drained at least one request, so a proven request stays
///      provable forever.
///
///      The proof's public values are nori-primitives' `ProofOutputs`: 220
///      bytes at fixed big-endian offsets, read here by slicing calldata.
///
///      Each ERC-20 locked on Ethereum is mirrored here by its own TIP-20:
///      the bridge adapter of Tempo's ERC-20 migration guide. Either the
///      bridge creates it (`registerMirror`), with this contract as its
///      admin, issuer and pauser, or the ERC-20's issuer creates it through
///      `TIP20Factory` with its own admin, grants this contract
///      `ISSUER_ROLE`, `PAUSE_ROLE` and `UNPAUSE_ROLE`, and the mirror admin
///      adopts it (`adoptMirror`); the issuer then keeps the token's
///      configuration (TIP-403 transfer policy, supply cap, logo, roles).
///      `mintERC20` mints it against a proven `[codeChallenge, token]`
///      deposit, and `applyPause` pauses or unpauses it from a proven
///      `[PAUSE_KEY, token]` pause state, so it follows the ERC-20's pause.
///      The leaves are told apart by their collection keys: an ETH deposit
///      has one key, an ERC-20 deposit two, and a pause state two starting
///      with `PAUSE_KEY`, which no deposit's codeChallenge can be.
contract NoriTempoTokenBridge {
    // -------------------------------
    // Constants
    // -------------------------------
    /// @notice Length of the proof's public values (nori-primitives `ProofOutputs::SIZE`).
    uint256 public constant PROOF_OUTPUTS_SIZE = 220;
    /// @notice Depth of a proof queue batch's request tree (nori-hash `merkle_sha256_fixed`).
    uint256 public constant MAX_TREE_DEPTH = 16;
    /// @notice Most requests one proof queue batch holds.
    uint256 public constant MAX_BATCH = 1 << MAX_TREE_DEPTH;
    /// @notice Most collection keys one request carries (nori-primitives `MAX_COLLECTION_KEYS`).
    uint8 public constant MAX_COLLECTION_KEYS = 2;
    /// @notice The first collection key of every pause state (`NoriTokenBridge.PAUSE_KEY`).
    bytes32 public constant PAUSE_KEY = keccak256("NORI_PAUSE_STATE");
    /// @notice A proven pause state of an unpaused ERC-20 (`NoriTokenBridge.PAUSE_STATE_UNPAUSED`).
    uint256 public constant PAUSE_STATE_UNPAUSED = 1;
    /// @notice A proven pause state of a paused ERC-20 (`NoriTokenBridge.PAUSE_STATE_PAUSED`).
    uint256 public constant PAUSE_STATE_PAUSED = 2;
    /// @notice Tempo's TIP-20 factory precompile, which creates each mirror.
    ITIP20Factory public constant TIP20_FACTORY = ITIP20Factory(0x20Fc000000000000000000000000000000000000);
    /// @notice pathUSD, the quote token every mirror is created with.
    ITIP20 public constant PATH_USD = ITIP20(0x20C0000000000000000000000000000000000000);
    /// @notice The TIP-20 role that mints and burns.
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    /// @notice The TIP-20 role that pauses.
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    /// @notice The TIP-20 role that unpauses.
    bytes32 public constant UNPAUSE_ROLE = keccak256("UNPAUSE_ROLE");

    // -------------------------------
    // Types
    // -------------------------------
    /// @notice The proof's public values, decoded.
    struct ProofOutputs {
        uint64 inputSlot;
        bytes32 inputStoreHash;
        uint64 outputSlot;
        bytes32 outputStoreHash;
        bytes32 executionStateRoot;
        bytes32 verifiedRequestsRoot;
        bytes32 nextSyncCommitteeHash;
        address proofRequestQueueAddress;
        uint64 inputQueueCursor;
        uint64 outputQueueCursor;
        uint64 outputBlockNumber;
    }

    /// @notice One committed proof queue batch: the root of its requests'
    ///         tree, the Ethereum block its proof read the queue at, the
    ///         request ids `[inputQueueCursor, outputQueueCursor)` it holds,
    ///         and the Tempo block that committed it. Two storage slots: the
    ///         root, then the four numbers.
    struct ProofRequestRootEntry {
        bytes32 root;
        uint64 outputBlockNumber;
        uint64 inputQueueCursor;
        uint64 outputQueueCursor;
        uint64 tempoBlockNumber;
    }

    /// @notice One verified request, carrying everything its leaf is hashed from.
    struct VerifiedRequest {
        address target;
        uint8 collectionKeysCount;
        bytes32[2] collectionKeys;
        uint256 value;
    }

    /// @notice A request's Merkle witness in its proof queue batch: the
    ///         bottom-up sibling path, the request's index in the batch, and
    ///         the request.
    struct VerifiedRequestWitness {
        bytes32[] path;
        uint64 index;
        VerifiedRequest value;
    }

    /// @notice The bridge's whole state, read at once.
    struct BridgeState {
        bytes32 verifiedStateRoot;
        uint64 latestHead;
        bytes32 noriBridgeVk;
        bytes32 latestHeliosStoreInputHash;
        address ethProofQueueAddress;
        address ethTokenBridgeAddress;
        uint64 queueCursor;
        uint64 proofQueueBatchCount;
    }

    // -------------------------------
    // Custom Errors
    // -------------------------------
    error ZeroAddress();

    // update
    error ProofVerificationFailed();
    error DecodingProofFailed(uint256 length);
    error ETHProofQueueAddressMismatch(address proven, address expected);
    error QueueCursorMismatch(uint64 proven, uint64 expected);
    error InputStoreHashMismatch(bytes32 proven, bytes32 expected);
    error InvalidOutputSlot(uint64 latestHead, uint64 outputSlot);
    error ZeroSyncCommitteeHash();

    // mint
    error NotTokenBridgeRequest(address target, address expected);
    error MintedExceedsLocked(uint64 lockedSoFar, uint64 mintedSoFar);
    error ZeroMintAmount();
    error LockedAmountOverflow(uint256 lockedSoFar);
    error CommitmentMismatch(bytes32 committed, bytes32 recipientCommitment);
    error ProofQueueBatchRootMismatch(bytes32 witnessRoot, bytes32 committedRoot);
    error WitnessIndexOutsideProofQueueBatch(uint64 index, uint64 proofQueueBatchSize);
    error InvalidDepositWitness();

    error CollectionKeysCountMismatch(uint8 count, uint8 expected);

    // ERC-20 mirrors
    error NotMirrorAdmin(address caller, address mirrorAdmin);
    error MirrorExists(address ethToken, ITIP20 mirror);
    error AlreadyAMirror(ITIP20 tip20, address ethToken);
    error NotTIP20(address tip20);
    error MissingMirrorRole(ITIP20 tip20, bytes32 role);
    error NoMirror(address ethToken);
    error InvalidTokenKey(bytes32 key);
    error NotPauseState(bytes32 key);
    error InvalidPauseState(uint256 value);
    error PauseNotNewer(uint64 proofQueueBatchIndex, uint64 appliedProofQueueBatchIndex);

    // proof queue batch reads
    error ProofQueueBatchNotCommitted(uint64 proofQueueBatchIndex, uint64 proofQueueBatchCount);
    error NoProofQueueBatchCovers(uint64 requestId);

    // -------------------------------
    // Events
    // -------------------------------
    /// @notice An update was applied: the bridge's new head, cursor, state root and batch count.
    event UpdateApplied(
        uint64 outputSlot,
        uint64 queueCursor,
        bytes32 verifiedStateRoot,
        uint64 proofQueueBatchCount
    );

    /// @notice An update's non-empty batch was committed at `proofQueueBatchIndex`.
    event ProofQueueBatchCommitted(
        uint64 indexed proofQueueBatchIndex,
        bytes32 root,
        uint64 inputQueueCursor,
        uint64 outputQueueCursor,
        uint64 outputBlockNumber
    );

    /// @notice Tokens were minted to `recipient` against a proven deposit.
    event MintApplied(
        address indexed recipient,
        bytes32 depositRoot,
        uint64 amountMinted,
        uint64 mintedSoFar
    );

    /// @notice `mirror` was created for the Ethereum ERC-20 `ethToken`.
    event MirrorRegistered(address indexed ethToken, ITIP20 indexed mirror, string name, string symbol);

    /// @notice The issuer's own TIP-20 `mirror` was adopted as the mirror of the Ethereum ERC-20 `ethToken`.
    event MirrorAdopted(address indexed ethToken, ITIP20 indexed mirror);

    /// @notice `ethToken`'s mirror was minted to `recipient` against a proven ERC-20 deposit.
    event ERC20MintApplied(
        address indexed ethToken,
        address indexed recipient,
        bytes32 depositRoot,
        uint64 amountMinted,
        uint64 mintedSoFar
    );

    /// @notice `ethToken`'s mirror follows its proven pause state from the batch at `proofQueueBatchIndex`.
    event PauseApplied(address indexed ethToken, ITIP20 indexed mirror, bool paused, uint64 proofQueueBatchIndex);

    // -------------------------------
    // Configuration (pinned at deploy)
    // -------------------------------
    /// @notice The SP1 Groth16 verifier (sp1-contracts v6.1.0, or a gateway routing to it).
    ISP1Verifier public immutable verifier;
    /// @notice The nori-bridge-head program vkey whose proofs are accepted.
    bytes32 public immutable noriBridgeVk;
    /// @notice The Ethereum `NoriProofRequestQueue` every proof anchors its storage proofs on.
    address public immutable ethProofQueueAddress;
    /// @notice The Ethereum `NoriTokenBridge` whose deposits mint here.
    address public immutable ethTokenBridgeAddress;
    /// @notice The bridged token: a TIP-20 for which this contract holds `ISSUER_ROLE`.
    ITIP20 public immutable token;
    /// @notice The account that registers ERC-20 mirrors: the deployer.
    address public immutable mirrorAdmin;

    // -------------------------------
    // State
    // -------------------------------
    // Storage layout, relied on by the tests that plant committed batches:
    // slot 0 `verifiedStateRoot`, slot 1 `latestHeliosStoreInputHash`, slot 2
    // `latestHead | queueCursor << 64 | proofQueueBatchCount << 128`, slot 3
    // `_proofQueueBatches` (entry at keccak256(index, 3): the root, then
    // `outputBlockNumber | inputQueueCursor << 64 | outputQueueCursor << 128 |
    // tempoBlockNumber << 192`), slot 4 `mintedSoFar`, slot 5 `mirrorOf`,
    // slot 6 `erc20MintedSoFar`, slot 7 `_pauseAppliedPlusOne`, slot 8
    // `ethTokenOf`, slot 9 `erc20TotalMinted`. Reordering the state
    // variables changes these.
    bytes32 public verifiedStateRoot;
    bytes32 public latestHeliosStoreInputHash;
    uint64 public latestHead;
    uint64 public queueCursor;
    uint64 public proofQueueBatchCount;

    mapping(uint64 => ProofRequestRootEntry) internal _proofQueueBatches;

    /// @notice Bridge units minted to each recipient so far.
    mapping(address => uint64) public mintedSoFar;

    /// @notice Ethereum ERC-20 -> its TIP-20 mirror.
    mapping(address => ITIP20) public mirrorOf;

    /// @notice Ethereum ERC-20 -> recipient -> bridge units of its mirror minted so far.
    mapping(address => mapping(address => uint64)) public erc20MintedSoFar;

    /// @dev Ethereum ERC-20 -> one past the batch index of its last applied pause state; 0 when none.
    mapping(address => uint64) internal _pauseAppliedPlusOne;

    /// @notice TIP-20 mirror -> the Ethereum ERC-20 it mirrors; zero for any other TIP-20.
    mapping(ITIP20 => address) public ethTokenOf;

    /// @notice Ethereum ERC-20 -> bridge units of its mirror minted by this
    ///         contract, to every recipient. Never more than the ERC-20's
    ///         `NoriTokenBridge.totalLockedERC20BU` on Ethereum.
    mapping(address => uint64) public erc20TotalMinted;

    // -------------------------------
    // Constructor
    // -------------------------------
    /// @dev The bridge starts at head 0 with an undrained queue (cursor 0)
    ///      and no verified state root; the first `update` is any proof whose
    ///      input store hash is `latestHeliosStoreInputHash_`.
    /// @param verifier_ The SP1 Groth16 verifier.
    /// @param noriBridgeVk_ The nori-bridge-head program vkey.
    /// @param token_ The bridged TIP-20; grant this contract `ISSUER_ROLE` on it after deploy.
    /// @param latestHeliosStoreInputHash_ The Helios store hash the first proof's input store hash must match.
    /// @param ethTokenBridgeAddress_ The Ethereum `NoriTokenBridge` whose deposits mint here.
    /// @param ethProofQueueAddress_ The Ethereum `NoriProofRequestQueue` every proof anchors on.
    constructor(
        ISP1Verifier verifier_,
        bytes32 noriBridgeVk_,
        ITIP20 token_,
        bytes32 latestHeliosStoreInputHash_,
        address ethTokenBridgeAddress_,
        address ethProofQueueAddress_
    ) {
        if (
            address(verifier_) == address(0) ||
            address(token_) == address(0) ||
            ethTokenBridgeAddress_ == address(0) ||
            ethProofQueueAddress_ == address(0)
        ) revert ZeroAddress();

        verifier = verifier_;
        noriBridgeVk = noriBridgeVk_;
        token = token_;
        ethTokenBridgeAddress = ethTokenBridgeAddress_;
        ethProofQueueAddress = ethProofQueueAddress_;
        mirrorAdmin = msg.sender;

        latestHeliosStoreInputHash = latestHeliosStoreInputHash_;
    }

    // -------------------------------
    // Update
    // -------------------------------
    /// @notice Advances the bridge's verified Ethereum light client state by one proof.
    /// @dev Permissionless. Verifies the proof against `noriBridgeVk`, then
    ///      requires it to resume exactly where the bridge stands and move it
    ///      forward. A batch that drained at least one request is committed at
    ///      the next proof queue batch index.
    /// @param proof The SP1 proof bytes: the verifier selector, then the encoded Groth16 proof.
    /// @param sp1PublicInputs The proof's public values (`ProofOutputs`, 220 bytes).
    function update(bytes calldata proof, bytes calldata sp1PublicInputs) external {
        try verifier.verifyProof(noriBridgeVk, sp1PublicInputs, proof) {} catch {
            revert ProofVerificationFailed();
        }

        ProofOutputs memory outputs = decodeProofOutputs(sp1PublicInputs);

        // The proof anchors its storage witnesses on the expected queue
        if (outputs.proofRequestQueueAddress != ethProofQueueAddress)
            revert ETHProofQueueAddressMismatch(outputs.proofRequestQueueAddress, ethProofQueueAddress);

        // Cursor continuity: the proof resumes exactly where the last one settled
        if (outputs.inputQueueCursor != queueCursor)
            revert QueueCursorMismatch(outputs.inputQueueCursor, queueCursor);

        // The input store hash chains from the last verified store hash
        if (outputs.inputStoreHash != latestHeliosStoreInputHash)
            revert InputStoreHashMismatch(outputs.inputStoreHash, latestHeliosStoreInputHash);

        // The proof head is past the latest verified head
        if (outputs.outputSlot <= latestHead) revert InvalidOutputSlot(latestHead, outputs.outputSlot);

        // The next sync committee hash is populated
        if (outputs.nextSyncCommitteeHash == bytes32(0)) revert ZeroSyncCommitteeHash();

        latestHead = outputs.outputSlot;
        latestHeliosStoreInputHash = outputs.outputStoreHash;
        verifiedStateRoot = outputs.executionStateRoot;
        queueCursor = outputs.outputQueueCursor;

        // Commit a batch that drained at least one request at the next index
        if (outputs.outputQueueCursor != outputs.inputQueueCursor) {
            uint64 proofQueueBatchIndex = proofQueueBatchCount;
            proofQueueBatchCount = proofQueueBatchIndex + 1;
            _proofQueueBatches[proofQueueBatchIndex] = ProofRequestRootEntry({
                root: outputs.verifiedRequestsRoot,
                outputBlockNumber: outputs.outputBlockNumber,
                inputQueueCursor: outputs.inputQueueCursor,
                outputQueueCursor: outputs.outputQueueCursor,
                tempoBlockNumber: uint64(block.number)
            });
            emit ProofQueueBatchCommitted(
                proofQueueBatchIndex,
                outputs.verifiedRequestsRoot,
                outputs.inputQueueCursor,
                outputs.outputQueueCursor,
                outputs.outputBlockNumber
            );
        }

        emit UpdateApplied(
            outputs.outputSlot,
            outputs.outputQueueCursor,
            outputs.executionStateRoot,
            proofQueueBatchCount
        );
    }

    // -------------------------------
    // Mint
    // -------------------------------
    /// @notice Mints the bridged token to the caller against a proven Ethereum deposit.
    /// @dev The deposit leaf's first collection key is the commitment
    ///      `sha256(recipient)` the depositor passed as `codeChallenge` to
    ///      `NoriTokenBridge.lockTokens`, where `recipient` is the 20-byte
    ///      Tempo address. The caller claims for itself: the contract hashes
    ///      `msg.sender` and compares it with the committed key, so the
    ///      recipient stays hidden on Ethereum until its first claim and only
    ///      the recipient can claim. Minting is delta-based
    ///      (`lockedSoFar - mintedSoFar`), so a reused claim reverts with
    ///      `ZeroMintAmount`.
    /// @param depositWitness The deposit's witness in its proof queue batch.
    /// @param proofQueueBatchIndex The committed batch the witness proves against.
    function mint(VerifiedRequestWitness calldata depositWitness, uint64 proofQueueBatchIndex) external {
        bytes32 root = _verifyTokenBridgeRequest(depositWitness, proofQueueBatchIndex, 1);
        VerifiedRequest calldata request = depositWitness.value;
        _checkRecipientCommitment(request.collectionKeys[0]);

        uint64 lockedSoFar = _lockedSoFar(request.value);
        uint64 amountToMint = _mintDelta(lockedSoFar, mintedSoFar[msg.sender]);

        mintedSoFar[msg.sender] = lockedSoFar;
        token.mint(msg.sender, amountToMint);

        emit MintApplied(msg.sender, root, amountToMint, lockedSoFar);
    }

    // -------------------------------
    // ERC-20 mirrors
    // -------------------------------
    /// @notice Creates the TIP-20 mirror of the Ethereum ERC-20 `ethToken`,
    ///         with this contract as its admin, issuer and pauser. Only the
    ///         mirror admin; once per ERC-20. Nobody else can change its
    ///         configuration; an issuer that wants to keep it uses
    ///         `adoptMirror` instead.
    /// @param ethToken The Ethereum ERC-20 `NoriTokenBridge.lockERC20` locks.
    /// @param name The mirror's name.
    /// @param symbol The mirror's symbol.
    /// @param currency The mirror's TIP-20 currency, immutable: what one unit
    ///        stays about 1:1 with (`"USD"` for a USD stablecoin, `"BTC"` for
    ///        wrapped bitcoin, its own symbol for an accumulating token). Only
    ///        `"USD"` tokens pay Tempo fees and trade on its stablecoin DEX.
    /// @param salt The TIP-20 factory salt.
    /// @return mirror The new TIP-20.
    function registerMirror(
        address ethToken,
        string calldata name,
        string calldata symbol,
        string calldata currency,
        bytes32 salt
    ) external returns (ITIP20 mirror) {
        if (msg.sender != mirrorAdmin) revert NotMirrorAdmin(msg.sender, mirrorAdmin);
        if (ethToken == address(0)) revert ZeroAddress();
        if (address(mirrorOf[ethToken]) != address(0)) revert MirrorExists(ethToken, mirrorOf[ethToken]);

        mirror = ITIP20(TIP20_FACTORY.createToken(name, symbol, currency, PATH_USD, address(this), salt));
        mirror.grantRole(ISSUER_ROLE, address(this));
        mirror.grantRole(PAUSE_ROLE, address(this));
        mirror.grantRole(UNPAUSE_ROLE, address(this));
        mirrorOf[ethToken] = mirror;
        ethTokenOf[mirror] = ethToken;

        emit MirrorRegistered(ethToken, mirror, name, symbol);
    }

    /// @notice Adopts the issuer's own TIP-20 `tip20` as the mirror of the
    ///         Ethereum ERC-20 `ethToken`. Only the mirror admin; once per
    ///         ERC-20, and a TIP-20 mirrors one ERC-20 at most.
    /// @dev The issuer creates `tip20` through `TIP20Factory` with its own
    ///      admin and grants this contract `ISSUER_ROLE` (to mint against
    ///      proven deposits), `PAUSE_ROLE` and `UNPAUSE_ROLE` (to follow the
    ///      ERC-20's pause) first; this checks all three. The issuer keeps
    ///      `DEFAULT_ADMIN_ROLE`: the transfer policy, supply cap, logo and
    ///      roles stay its own, so it can also revoke the bridge's roles. A
    ///      mint the supply cap or the transfer policy refuses reverts and
    ///      can be claimed again once they allow it.
    /// @param ethToken The Ethereum ERC-20 `NoriTokenBridge.lockERC20` locks.
    /// @param tip20 The issuer's TIP-20.
    function adoptMirror(address ethToken, ITIP20 tip20) external {
        if (msg.sender != mirrorAdmin) revert NotMirrorAdmin(msg.sender, mirrorAdmin);
        if (ethToken == address(0) || address(tip20) == address(0)) revert ZeroAddress();
        if (address(mirrorOf[ethToken]) != address(0)) revert MirrorExists(ethToken, mirrorOf[ethToken]);
        if (ethTokenOf[tip20] != address(0)) revert AlreadyAMirror(tip20, ethTokenOf[tip20]);
        if (tip20 == token || !TIP20_FACTORY.isTIP20(address(tip20))) revert NotTIP20(address(tip20));
        _requireMirrorRole(tip20, ISSUER_ROLE);
        _requireMirrorRole(tip20, PAUSE_ROLE);
        _requireMirrorRole(tip20, UNPAUSE_ROLE);

        mirrorOf[ethToken] = tip20;
        ethTokenOf[tip20] = ethToken;

        emit MirrorAdopted(ethToken, tip20);
    }

    /// @dev This contract holds `role` on `tip20` (TIP-20's `hasRole` takes the account first).
    function _requireMirrorRole(ITIP20 tip20, bytes32 role) internal view {
        if (!tip20.hasRole(address(this), role)) revert MissingMirrorRole(tip20, role);
    }

    /// @notice Mints an ERC-20's mirror to the caller against a proven
    ///         `NoriTokenBridge.lockERC20` deposit.
    /// @dev The deposit leaf is `[codeChallenge, token]` -> bridge units
    ///      locked so far; the caller claims for itself as in `mint`. A
    ///      mirror has 6 decimals, so a bridge unit is one of its units.
    /// @param depositWitness The deposit's witness in its proof queue batch.
    /// @param proofQueueBatchIndex The committed batch the witness proves against.
    function mintERC20(VerifiedRequestWitness calldata depositWitness, uint64 proofQueueBatchIndex) external {
        bytes32 root = _verifyTokenBridgeRequest(depositWitness, proofQueueBatchIndex, 2);
        VerifiedRequest calldata request = depositWitness.value;
        _checkRecipientCommitment(request.collectionKeys[0]);
        address ethToken = _tokenOfKey(request.collectionKeys[1]);
        ITIP20 mirror = _mirror(ethToken);

        uint64 lockedSoFar = _lockedSoFar(request.value);
        uint64 amountToMint = _mintDelta(lockedSoFar, erc20MintedSoFar[ethToken][msg.sender]);

        erc20MintedSoFar[ethToken][msg.sender] = lockedSoFar;
        erc20TotalMinted[ethToken] += amountToMint;
        mirror.mint(msg.sender, amountToMint);

        emit ERC20MintApplied(ethToken, msg.sender, root, amountToMint, lockedSoFar);
    }

    /// @notice Pauses or unpauses an ERC-20's mirror to match its proven
    ///         pause state (`NoriTokenBridge.syncPause`). Anyone may call it.
    /// @dev The leaf is `[PAUSE_KEY, token]` -> `PAUSE_STATE_UNPAUSED` or
    ///      `PAUSE_STATE_PAUSED`. A batch's proof read the state at its own
    ///      Ethereum block, so only a batch newer than the last one applied
    ///      for the token is accepted.
    /// @param pauseWitness The pause state's witness in its proof queue batch.
    /// @param proofQueueBatchIndex The committed batch the witness proves against.
    function applyPause(VerifiedRequestWitness calldata pauseWitness, uint64 proofQueueBatchIndex) external {
        _verifyTokenBridgeRequest(pauseWitness, proofQueueBatchIndex, 2);
        VerifiedRequest calldata request = pauseWitness.value;
        if (request.collectionKeys[0] != PAUSE_KEY) revert NotPauseState(request.collectionKeys[0]);
        address ethToken = _tokenOfKey(request.collectionKeys[1]);
        ITIP20 mirror = _mirror(ethToken);
        if (request.value != PAUSE_STATE_UNPAUSED && request.value != PAUSE_STATE_PAUSED)
            revert InvalidPauseState(request.value);

        uint64 appliedPlusOne = _pauseAppliedPlusOne[ethToken];
        if (appliedPlusOne != 0 && proofQueueBatchIndex < appliedPlusOne)
            revert PauseNotNewer(proofQueueBatchIndex, appliedPlusOne - 1);
        _pauseAppliedPlusOne[ethToken] = proofQueueBatchIndex + 1;

        bool paused = request.value == PAUSE_STATE_PAUSED;
        if (mirror.paused() != paused) {
            if (paused) mirror.pause();
            else mirror.unpause();
        }

        emit PauseApplied(ethToken, mirror, paused, proofQueueBatchIndex);
    }

    /// @notice The batch index of the last pause state applied for `ethToken`.
    /// @return applied Whether any has been.
    /// @return proofQueueBatchIndex Its batch index, when one has.
    function lastPauseApplied(address ethToken) external view returns (bool applied, uint64 proofQueueBatchIndex) {
        uint64 appliedPlusOne = _pauseAppliedPlusOne[ethToken];
        applied = appliedPlusOne != 0;
        if (applied) proofQueueBatchIndex = appliedPlusOne - 1;
    }

    /// @dev Checks a witness of an Ethereum `NoriTokenBridge` request against
    ///      a committed batch, and its number of collection keys.
    /// @return root The batch root the witness resolves to.
    function _verifyTokenBridgeRequest(
        VerifiedRequestWitness calldata witness,
        uint64 proofQueueBatchIndex,
        uint8 collectionKeysCount
    ) internal view returns (bytes32 root) {
        _validateWitness(witness);

        ProofRequestRootEntry memory batch = proofQueueBatch(proofQueueBatchIndex);

        root = verifiedRequestWitnessRoot(witness);
        if (root != batch.root) revert ProofQueueBatchRootMismatch(root, batch.root);

        uint64 proofQueueBatchSize = batch.outputQueueCursor - batch.inputQueueCursor;
        if (witness.index >= proofQueueBatchSize)
            revert WitnessIndexOutsideProofQueueBatch(witness.index, proofQueueBatchSize);

        VerifiedRequest calldata request = witness.value;
        if (request.target != ethTokenBridgeAddress)
            revert NotTokenBridgeRequest(request.target, ethTokenBridgeAddress);
        if (request.collectionKeysCount != collectionKeysCount)
            revert CollectionKeysCountMismatch(request.collectionKeysCount, collectionKeysCount);
    }

    /// @dev The caller is the recipient a deposit committed to.
    function _checkRecipientCommitment(bytes32 committed) internal view {
        bytes32 recipientCommitment = sha256(abi.encodePacked(msg.sender));
        if (committed != recipientCommitment) revert CommitmentMismatch(committed, recipientCommitment);
    }

    /// @dev A proven locked-so-far word, which `NoriTokenBridge` caps at 2^64 - 1.
    function _lockedSoFar(uint256 value) internal pure returns (uint64) {
        if (value > type(uint64).max) revert LockedAmountOverflow(value);
        return uint64(value);
    }

    /// @dev What to mint: the locked amount not yet minted.
    function _mintDelta(uint64 lockedSoFar, uint64 minted) internal pure returns (uint64 amountToMint) {
        if (lockedSoFar < minted) revert MintedExceedsLocked(lockedSoFar, minted);
        amountToMint = lockedSoFar - minted;
        if (amountToMint == 0) revert ZeroMintAmount();
    }

    /// @dev The ERC-20 address a collection key holds, left-padded to 32 bytes.
    function _tokenOfKey(bytes32 key) internal pure returns (address) {
        if (uint256(key) >> 160 != 0) revert InvalidTokenKey(key);
        return address(uint160(uint256(key)));
    }

    /// @dev `ethToken`'s registered mirror.
    function _mirror(address ethToken) internal view returns (ITIP20 mirror) {
        mirror = mirrorOf[ethToken];
        if (address(mirror) == address(0)) revert NoMirror(ethToken);
    }

    // -------------------------------
    // Reads
    // -------------------------------
    /// @notice The bridge's whole state.
    function state() external view returns (BridgeState memory) {
        return
            BridgeState({
                verifiedStateRoot: verifiedStateRoot,
                latestHead: latestHead,
                noriBridgeVk: noriBridgeVk,
                latestHeliosStoreInputHash: latestHeliosStoreInputHash,
                ethProofQueueAddress: ethProofQueueAddress,
                ethTokenBridgeAddress: ethTokenBridgeAddress,
                queueCursor: queueCursor,
                proofQueueBatchCount: proofQueueBatchCount
            });
    }

    /// @notice The committed proof queue batch at `proofQueueBatchIndex`.
    function proofQueueBatch(uint64 proofQueueBatchIndex) public view returns (ProofRequestRootEntry memory) {
        if (proofQueueBatchIndex >= proofQueueBatchCount)
            revert ProofQueueBatchNotCommitted(proofQueueBatchIndex, proofQueueBatchCount);
        return _proofQueueBatches[proofQueueBatchIndex];
    }

    /// @notice The committed proof queue batches at `fromIndex .. fromIndex + count`.
    function proofQueueBatches(uint64 fromIndex, uint64 count) external view returns (ProofRequestRootEntry[] memory batches) {
        uint64 end = fromIndex + count;
        if (end > proofQueueBatchCount) revert ProofQueueBatchNotCommitted(end - 1, proofQueueBatchCount);
        batches = new ProofRequestRootEntry[](count);
        for (uint64 i = 0; i < count; i++) batches[i] = _proofQueueBatches[fromIndex + i];
    }

    /// @notice The committed proof queue batch whose `[inputQueueCursor, outputQueueCursor)` covers `requestId`.
    /// @dev Batches are contiguous and their cursor ranges increase (each
    ///      resumes at the previous one's output cursor), so this is a binary
    ///      search for the last batch starting at or before `requestId`.
    function findProofQueueBatch(
        uint64 requestId
    ) external view returns (uint64 proofQueueBatchIndex, ProofRequestRootEntry memory batch) {
        uint64 low = 0;
        uint64 high = proofQueueBatchCount;
        if (high == 0 || _proofQueueBatches[0].inputQueueCursor > requestId) revert NoProofQueueBatchCovers(requestId);
        while (high - low > 1) {
            uint64 middle = low + (high - low) / 2;
            if (_proofQueueBatches[middle].inputQueueCursor <= requestId) low = middle;
            else high = middle;
        }
        batch = _proofQueueBatches[low];
        if (requestId >= batch.outputQueueCursor) revert NoProofQueueBatchCovers(requestId);
        proofQueueBatchIndex = low;
    }

    // -------------------------------
    // Proof outputs, leaves and witnesses
    // -------------------------------
    /// @notice Decodes the proof's public values (`ProofOutputs`, 220 bytes, big-endian).
    function decodeProofOutputs(bytes calldata publicValues) public pure returns (ProofOutputs memory outputs) {
        if (publicValues.length != PROOF_OUTPUTS_SIZE) revert DecodingProofFailed(publicValues.length);
        outputs.inputSlot = uint64(bytes8(publicValues[0:8]));
        outputs.inputStoreHash = bytes32(publicValues[8:40]);
        outputs.outputSlot = uint64(bytes8(publicValues[40:48]));
        outputs.outputStoreHash = bytes32(publicValues[48:80]);
        outputs.executionStateRoot = bytes32(publicValues[80:112]);
        outputs.verifiedRequestsRoot = bytes32(publicValues[112:144]);
        outputs.nextSyncCommitteeHash = bytes32(publicValues[144:176]);
        outputs.proofRequestQueueAddress = address(bytes20(publicValues[176:196]));
        outputs.inputQueueCursor = uint64(bytes8(publicValues[196:204]));
        outputs.outputQueueCursor = uint64(bytes8(publicValues[204:212]));
        outputs.outputBlockNumber = uint64(bytes8(publicValues[212:220]));
    }

    /// @notice Hashes one verified request into its Merkle leaf, as nori-hash's
    ///         `hash_request_leaf` does: SHA-256 over four 32-byte fields.
    /// @dev Field 1 is `target` (20) ++ `collectionKeysCount` ++ the first
    ///      byte of each key and of `value`, zero padded. Fields 2 to 4 are
    ///      bytes 1..32 of key 0, key 1 and `value`, each zero padded, which
    ///      is the 32-byte word shifted left by one byte. `collectionKeysCount`
    ///      is hashed so that an unused trailing key, which is zero, cannot
    ///      collide with a request that supplied a zero key.
    function requestLeafHash(VerifiedRequest calldata request) public pure returns (bytes32) {
        bytes32 key0 = request.collectionKeys[0];
        bytes32 key1 = request.collectionKeys[1];
        bytes32 value = bytes32(request.value);
        return
            sha256(
                abi.encodePacked(
                    request.target,
                    request.collectionKeysCount,
                    key0[0],
                    key1[0],
                    value[0],
                    bytes8(0),
                    key0 << 8,
                    key1 << 8,
                    value << 8
                )
            );
    }

    /// @notice The root a witness resolves to: its leaf hashed up the path,
    ///         taking each level's side from the matching bit of `index`.
    function verifiedRequestWitnessRoot(VerifiedRequestWitness calldata witness) public pure returns (bytes32 node) {
        node = requestLeafHash(witness.value);
        for (uint256 level = 0; level < witness.path.length; level++) {
            bytes32 sibling = witness.path[level];
            node = (witness.index >> level) & 1 == 1
                ? sha256(abi.encodePacked(sibling, node))
                : sha256(abi.encodePacked(node, sibling));
        }
    }

    /// @dev A witness is well formed when its index fits a batch, its path
    ///      fits the tree and its request carries at most `MAX_COLLECTION_KEYS` keys.
    function _validateWitness(VerifiedRequestWitness calldata witness) internal pure {
        if (
            witness.index > MAX_BATCH - 1 ||
            witness.path.length > MAX_TREE_DEPTH ||
            witness.value.collectionKeysCount > MAX_COLLECTION_KEYS
        ) revert InvalidDepositWitness();
    }
}
