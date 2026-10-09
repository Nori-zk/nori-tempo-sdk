import { id } from "ethers";

/** Decimals of a bridge unit (`NoriTokenBridge.DECIMALS`). */
export const DECIMALS = 6;

/** Most bridge units one commitment, or all of them, may hold (`NoriTokenBridge.MAX_MAGNITUDE`): 2^64 - 1. */
export const MAX_MAGNITUDE = (1n << 64n) - 1n;

/** The smallest bridge unit (BU) in wei (`NoriTokenBridge.WEI_PER_BRIDGE_UNIT`). */
export const WEI_PER_BRIDGE_UNIT = 10n ** BigInt(18 - DECIMALS);

/** The lock fee rate's hard cap, 10% (`NoriTokenBridge.MAX_FEE_RATE`); one rate unit is 0.001%. */
export const MAX_FEE_RATE = 10_000;

/** What the lock fee rate is a fraction of (`NoriTokenBridge.FEE_DENOMINATOR`). */
export const FEE_DENOMINATOR = 100_000;

/** The smallest lock fee, in bridge units (`NoriTokenBridge.MIN_FEE_BU`). */
export const MIN_FEE_BU = 10n;

/** Smallest deposit `lockTokens` accepts, 0.001 ETH (`NoriTokenBridge.MIN_LOCK_AMOUNT_WEI`). */
export const MIN_LOCK_AMOUNT_WEI = 1000n * WEI_PER_BRIDGE_UNIT;

/** Storage slot index of `lockedTokens` (`NoriTokenBridge.LOCKED_TOKENS_SLOT_INDEX`), which every deposit's storage key is derived from. */
export const LOCKED_TOKENS_SLOT_INDEX = 2n;

/** Storage slot index of `lockedERC20` (`NoriTokenBridge.LOCKED_ERC20_SLOT_INDEX`), which every ERC-20 deposit's storage key is derived from. */
export const LOCKED_ERC20_SLOT_INDEX = 6n;

/** Storage slot index of `pauseState` (`NoriTokenBridge.PAUSE_STATE_SLOT_INDEX`), which every pause request's storage key is derived from. */
export const PAUSE_STATE_SLOT_INDEX = 8n;

/** The first collection key of every pause request (`NoriTokenBridge.PAUSE_KEY`). */
export const PAUSE_KEY = id("NORI_PAUSE_STATE");

/** `pauseState` of a token last synced unpaused (`NoriTokenBridge.PAUSE_STATE_UNPAUSED`). */
export const PAUSE_STATE_UNPAUSED = 1n;

/** `pauseState` of a token last synced paused (`NoriTokenBridge.PAUSE_STATE_PAUSED`). */
export const PAUSE_STATE_PAUSED = 2n;
