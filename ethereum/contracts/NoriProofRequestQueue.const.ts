/** Most collection keys a single request carries (`NoriProofRequestQueue.MAX_COLLECTION_KEYS`). */
export const MAX_COLLECTION_KEYS = 2;

/** Fees are whole multiples of this, 10^12 wei (`NoriProofRequestQueue.PROOF_REQUEST_QUEUE_FEE_GRANULARITY_WEI`). */
export const PROOF_REQUEST_QUEUE_FEE_GRANULARITY_WEI = 10n ** 12n;

/** The fee's hard ceiling, 0.05 ETH (`NoriProofRequestQueue.MAX_PROOF_REQUEST_QUEUE_FEE`). */
export const MAX_PROOF_REQUEST_QUEUE_FEE = 5n * 10n ** 16n;
