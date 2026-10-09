// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {ITIP20} from "./ITIP20.sol";

/// @title ITIP20Factory
/// @notice Tempo's TIP-20 factory precompile, at
///         `0x20Fc000000000000000000000000000000000000`. `admin` receives the
///         token's `DEFAULT_ADMIN_ROLE`, which grants the other roles.
interface ITIP20Factory {
    event TokenCreated(
        address indexed token,
        string name,
        string symbol,
        string currency,
        ITIP20 quoteToken,
        address admin,
        bytes32 salt
    );

    function createToken(
        string memory name,
        string memory symbol,
        string memory currency,
        ITIP20 quoteToken,
        address admin,
        bytes32 salt
    ) external returns (address token);
}
