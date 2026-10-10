/** A request to an EVM chain's node (Ethereum or Tempo) that failed, and may not have reached it. */
export class EvmRpcTransportError extends Error {
    constructor(message: string, readonly cause: unknown) {
        super(message);
        this.name = 'EvmRpcTransportError';
    }
}

/** An EVM chain's node has no such data, e.g. no finalized block. */
export class EvmDataNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EvmDataNotFoundError';
    }
}
