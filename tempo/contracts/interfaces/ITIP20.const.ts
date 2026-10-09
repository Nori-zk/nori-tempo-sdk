/** Tempo's `TIP20Factory` precompile (`ITIP20Factory`), on every Tempo network. */
export const TIP20_FACTORY_ADDRESS = "0x20Fc000000000000000000000000000000000000";

/** pathUSD, the TIP-20 every Tempo network has at this address; the quote token bridged tokens are created with. */
export const PATH_USD_ADDRESS = "0x20C0000000000000000000000000000000000000";

/** Decimals of every TIP-20 (`ITIP20.decimals`). */
export const TIP20_DECIMALS = 6;

/** The TIP-20 role that mints (`ITIP20.mint`); roles are the keccak256 of their names. */
export const ISSUER_ROLE_NAME = "ISSUER_ROLE";

/** The TIP-20 role that pauses (`ITIP20.pause`). */
export const PAUSE_ROLE_NAME = "PAUSE_ROLE";

/** The TIP-20 role that unpauses (`ITIP20.unpause`). */
export const UNPAUSE_ROLE_NAME = "UNPAUSE_ROLE";
