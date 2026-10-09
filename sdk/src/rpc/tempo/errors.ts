export class ProofQueueBatchSearchError extends Error {
    constructor(readonly requestId: bigint, message: string) {
        super(message);
        this.name = 'ProofQueueBatchSearchError';
    }
}
