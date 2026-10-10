import { filter, firstValueFrom, type Observable } from 'rxjs';
import { createConnectionStatusMachine, httpStatus } from '../../rpc/connection/connectionStatus.impl.js';
import { type ConnectionStatusState } from '../../rpc/connection/connectionStatus.js';
import {
    createContiguousBatches,
    createFakeEthereumProvider,
    createFakeTempoProvider,
    createTestConnections,
    nodesUntil,
    waitForNode,
} from '../testUtils.js';

/** Both test chains' http machines, each answering its health checks until told not to. */
function setUp() {
    const ethereum = createFakeEthereumProvider([], { latestBlock: 100 });
    const tempo = createFakeTempoProvider(createContiguousBatches([]));
    return createTestConnections(ethereum.provider, tempo.provider);
}

/**
 * Waits for a status machine to reach `node` with `data`.
 *
 * @param machine The running status machine.
 * @param node The node.
 * @param data The node's data.
 * @returns Once it is there.
 */
const waitForNodeWith = (
    machine: { state$: Observable<ConnectionStatusState> },
    node: ConnectionStatusState['node'],
    data: object
) =>
    firstValueFrom(
        machine.state$.pipe(
            filter((state) => state.node === node && JSON.stringify(state.data) === JSON.stringify(data))
        )
    );

describe('connection status machine', () => {
    test('is unsure until its transport answers, then connected through it', async () => {
        const { connections, close } = setUp();
        const connectionStatus = createConnectionStatusMachine([
            connections.ethereum.http.connection.state$.pipe(httpStatus('http')),
        ]);
        expect((await firstValueFrom(connectionStatus.state$)).node).toBe('unsure');
        await waitForNodeWith(connectionStatus, 'connected', { transport: 'http' });
        connectionStatus.close();
        close();
    });

    test('a node that stops answering is unsure at the first failure, down at the second, connected once back', async () => {
        const { connections, world, close } = setUp();
        const connectionStatus = createConnectionStatusMachine([
            connections.ethereum.http.connection.state$.pipe(httpStatus('http')),
        ]);
        await waitForNodeWith(connectionStatus, 'connected', { transport: 'http' });
        const moves = nodesUntil(connectionStatus, 'down');

        world.ethereumAnswers = false;
        expect(await moves).toEqual(['unsure', 'down']);
        await waitForNodeWith(connectionStatus, 'down', { reason: 'unreachable' });

        world.ethereumAnswers = true;
        await waitForNodeWith(connectionStatus, 'connected', { transport: 'http' });
        connectionStatus.close();
        close();
    });

    test('is connected through the first transport up in its order, and follows another taking over', async () => {
        const { connections, world, close } = setUp();
        world.ethereumAnswers = false;
        await waitForNode(connections.ethereum.http.connection, 'unreachable');
        const connectionStatus = createConnectionStatusMachine([
            connections.ethereum.http.connection.state$.pipe(httpStatus('first')),
            connections.tempo.http.connection.state$.pipe(httpStatus('second')),
        ]);
        await waitForNodeWith(connectionStatus, 'connected', { transport: 'second' });

        world.ethereumAnswers = true;
        await waitForNodeWith(connectionStatus, 'connected', { transport: 'first' });
        connectionStatus.close();
        close();
    });

    test('closes', async () => {
        const { connections, close } = setUp();
        const connectionStatus = createConnectionStatusMachine([
            connections.ethereum.http.connection.state$.pipe(httpStatus('http')),
        ]);
        await waitForNodeWith(connectionStatus, 'connected', { transport: 'http' });
        connectionStatus.close();
        await waitForNode(connectionStatus, 'closed');
        close();
    });
});
