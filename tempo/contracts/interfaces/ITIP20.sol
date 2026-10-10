// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @title ITIP20
/// @notice The part of Tempo's TIP-20 token standard the bridge and its
///         deploy use: minting as the token's `ISSUER_ROLE` holder, pausing
///         and unpausing as its `PAUSE_ROLE` and `UNPAUSE_ROLE` holder,
///         granting those roles as its admin, and checking who holds them.
///         Each role is the keccak256 of its name. TIP-20 tokens have 6
///         decimals.
interface ITIP20 {
    function grantRole(bytes32 role, address account) external;

    /// @dev The account comes first, unlike OpenZeppelin's `hasRole(role, account)`.
    function hasRole(address account, bytes32 role) external view returns (bool);

    function mint(address to, uint256 amount) external;

    function pause() external;

    function unpause() external;

    function paused() external view returns (bool);

    function totalSupply() external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function decimals() external view returns (uint8);
}
