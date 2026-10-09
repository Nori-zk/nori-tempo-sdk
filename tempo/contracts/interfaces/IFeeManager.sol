// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/// @title IFeeManager
/// @notice The part of Tempo's fee manager precompile, at
///         `0xfeEC000000000000000000000000000000000000`, that reads which USD
///         TIP-20 an account pays its transaction fees in.
interface IFeeManager {
    /// @notice The fee token `user` chose; the zero address when it chose none.
    function userTokens(address user) external view returns (address);
}
