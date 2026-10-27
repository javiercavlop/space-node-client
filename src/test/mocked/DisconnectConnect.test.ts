import http from 'node:http';
import net, { AddressInfo } from 'node:net';
import { Server as SocketIOServer } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceClient } from '../../main/index';

const WAIT = { timeout: 5000, interval: 20 };

/** A Socket.IO server on `/events` with the `/pricings` namespace, as SPACE exposes them. */
class PricingEventsServer {
  public io!: SocketIOServer;
  private server = http.createServer();

  async start(): Promise<string> {
    this.io = new SocketIOServer(this.server, { path: '/events', transports: ['websocket'] });
    this.io.of('/pricings');
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  connectedClients(): number {
    return this.io.of('/pricings').sockets.size;
  }

  /** Open Engine.IO connections, whether or not they joined a namespace. */
  openConnections(): number {
    return this.io.engine.clientsCount;
  }

  emitPricing(code: string, details: unknown): void {
    this.io.of('/pricings').emit('message', { code, details });
  }

  async stop(): Promise<void> {
    await new Promise<void>(resolve => this.io.close(() => resolve()));
  }
}

describe('SpaceClient disconnect/connect cycles', { timeout: 30000 }, () => {
  let server: PricingEventsServer;
  let url: string;
  let client: SpaceClient | undefined;

  beforeEach(async () => {
    server = new PricingEventsServer();
    url = await server.start();
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await server.stop();
  });

  async function reconnect(c: SpaceClient): Promise<void> {
    c.disconnect();
    await vi.waitFor(() => expect(server.connectedClients()).toBe(0), WAIT);
    c.connect();
  }

  it('fires synchronized and pricing events after several disconnect/connect cycles, once each', async () => {
    let synchronizedCount = 0;
    const created: unknown[] = [];
    client = new SpaceClient({ url, apiKey: 'test-api-key' });
    client.on('synchronized', () => synchronizedCount++);
    client.on('pricing_created', data => created.push(data));

    await vi.waitFor(() => expect(synchronizedCount).toBe(1), WAIT);
    server.emitPricing('PRICING_CREATED', { serviceName: 'Zoom', pricingVersion: 'v1' });
    await vi.waitFor(() => expect(created).toHaveLength(1), WAIT);

    for (let cycle = 1; cycle <= 3; cycle++) {
      await reconnect(client);
      const expected = cycle + 1;
      await vi.waitFor(() => expect(synchronizedCount).toBe(expected), WAIT);
      server.emitPricing('PRICING_CREATED', { serviceName: 'Zoom', pricingVersion: `v${expected}` });
      await vi.waitFor(() => expect(created).toHaveLength(expected), WAIT);
    }

    // No handler was registered twice: nothing more arrives.
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(synchronizedCount).toBe(4);
    expect(created).toEqual([
      { serviceName: 'Zoom', pricingVersion: 'v1' },
      { serviceName: 'Zoom', pricingVersion: 'v2' },
      { serviceName: 'Zoom', pricingVersion: 'v3' },
      { serviceName: 'Zoom', pricingVersion: 'v4' },
    ]);
  });

  it('delivers events to a listener registered while disconnected', async () => {
    let synchronizedCount = 0;
    const archived: unknown[] = [];
    client = new SpaceClient({ url, apiKey: 'test-api-key' });
    client.on('synchronized', () => synchronizedCount++);
    await vi.waitFor(() => expect(synchronizedCount).toBe(1), WAIT);

    client.disconnect();
    await vi.waitFor(() => expect(server.connectedClients()).toBe(0), WAIT);
    client.on('pricing_archived', data => archived.push(data));
    client.connect();

    await vi.waitFor(() => expect(synchronizedCount).toBe(2), WAIT);
    server.emitPricing('PRICING_ARCHIVED', { serviceName: 'Zoom', pricingVersion: 'v1' });
    await vi.waitFor(() => expect(archived).toHaveLength(1), WAIT);
  });

  it('connects again when connect() is called right after disconnect()', async () => {
    let synchronizedCount = 0;
    const created: unknown[] = [];
    client = new SpaceClient({ url, apiKey: 'test-api-key' });
    client.on('synchronized', () => synchronizedCount++);
    client.on('pricing_created', data => created.push(data));
    await vi.waitFor(() => expect(synchronizedCount).toBe(1), WAIT);

    client.disconnect();
    client.connect();

    await vi.waitFor(() => expect(synchronizedCount).toBe(2), WAIT);
    server.emitPricing('PRICING_CREATED', { serviceName: 'Zoom', pricingVersion: 'v2' });
    await vi.waitFor(() => expect(created).toHaveLength(1), WAIT);
    // The old connection is closed and no other one was left open.
    await vi.waitFor(() => expect(server.openConnections()).toBe(1), WAIT);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(server.openConnections()).toBe(1);
    expect(synchronizedCount).toBe(2);
    expect(created).toHaveLength(1);
  });
});

/** Accepts TCP connections and drops them at once, counting them: a SPACE that cannot be reached. */
class UnreachableSpace {
  public attempts = 0;
  private server = net.createServer(socket => {
    this.attempts++;
    socket.destroy();
  });

  async start(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', () => resolve()));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}

describe('SpaceClient stops reconnecting to an unreachable SPACE', { timeout: 30000 }, () => {
  // socket.io-client retries after 1 s +/- 50 % (reconnectionDelay, randomizationFactor).
  const QUIET_WINDOW_MS = 3000;
  let space: UnreachableSpace;
  let client: SpaceClient | undefined;

  beforeEach(() => {
    space = new UnreachableSpace();
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await space.stop();
  });

  async function expectNoFurtherAttempts(): Promise<void> {
    const attempts = space.attempts;
    await new Promise(resolve => setTimeout(resolve, QUIET_WINDOW_MS));
    expect(space.attempts).toBe(attempts);
  }

  it('makes no further attempts after close()', async () => {
    const errors: unknown[] = [];
    client = new SpaceClient({ url: await space.start(), apiKey: 'test-api-key' });
    client.on('error', error => errors.push(error));
    await vi.waitFor(() => expect(space.attempts).toBeGreaterThanOrEqual(1), WAIT);
    await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(1), WAIT);

    await client.close();

    await expectNoFurtherAttempts();
  });

  it('makes no further attempts after disconnect(), and connect() tries again', async () => {
    client = new SpaceClient({ url: await space.start(), apiKey: 'test-api-key' });
    await vi.waitFor(() => expect(space.attempts).toBeGreaterThanOrEqual(1), WAIT);

    client.disconnect();
    await expectNoFurtherAttempts();

    const attempts = space.attempts;
    client.connect();
    await vi.waitFor(() => expect(space.attempts).toBeGreaterThan(attempts), WAIT);
  });
});
