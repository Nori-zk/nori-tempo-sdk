import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import { readFileSync } from 'fs';
import type { NoriSP1ProofInput } from '@nori-zk/pts-types';

const slots = [
    '11298112',
    '11298144',
    '11298176',
    '11298208',
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadProof(filePath: string): NoriSP1ProofInput {
    return JSON.parse(readFileSync(filePath, 'utf8')) as NoriSP1ProofInput;
}

export function buildExampleProofCreateArgument(): NoriSP1ProofInput {
    return loadProof(path.resolve(__dirname, 'proofs', 'sp1Proof.json'));
}

export function buildExampleProofSeriesCreateArguments(): Array<NoriSP1ProofInput> {
    return slots.map((slot) =>
        loadProof(path.resolve(__dirname, 'test_examples', slot, 'sp1Proof.json'))
    );
}
