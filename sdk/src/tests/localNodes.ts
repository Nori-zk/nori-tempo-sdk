import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/** A running local node: its http RPC URL, and how to stop it. */
export interface LocalNode {
    url: string;
    stop(): void;
}

/** How long `startAnvil` waits for the node's RPC to answer. */
const START_TIMEOUT_MS = 90_000;

/** A free local port, from the OS. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() =>
                typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No port.'))
            );
        });
    });
}

/** Resolves once `url` answers `eth_chainId`, or rejects after `START_TIMEOUT_MS`. */
async function waitForRpc(url: string, node: ChildProcess): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (node.exitCode !== null) throw new Error(`anvil exited with code ${node.exitCode}.`);
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
            });
            if (response.ok) return;
        } catch {
            // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`anvil at ${url} did not answer within ${START_TIMEOUT_MS / 1000} s.`);
}

/**
 * Starts `anvil` (Foundry, on PATH) on a free port with `args`, e.g.
 * `['--network', 'tempo']` for a local Tempo node or `['--fork-url', url]`
 * for a fork of Ethereum.
 *
 * @param args anvil's arguments besides the port.
 * @returns The node, once its RPC answers.
 */
export async function startAnvil(args: string[]): Promise<LocalNode> {
    const port = await freePort();
    const node = spawn('anvil', ['--port', String(port), ...args], { stdio: 'ignore' });
    const url = `http://127.0.0.1:${port}`;
    const stop = () => {
        node.kill();
    };
    try {
        await waitForRpc(url, node);
    } catch (error) {
        stop();
        throw error;
    }
    return { url, stop };
}
