import { describe, it, expect, beforeAll, afterAll, expectTypeOf } from 'vitest';
import type { Socket as ServerSocket } from 'socket.io';
import {
  CacheType,
  ContractEventDetails,
  EventIdWindow,
  PricingEventDetails,
  ResyncInfo,
  SpaceClient,
  SpaceConnectionOptions,
  SpaceEventMeta,
  connect,
} from '../../main/index';
import { MockSpace } from './mockSpace';

const API_KEY = 'test-org-key';

function waitFor<T>(register: (resolve: (value: T) => void) => void, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for event')), ms);
    register(value => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function until(condition: () => boolean, ms = 4000): Promise<void> {
  return waitFor<void>(resolve => {
    const check = () => (condition() ? resolve() : setTimeout(check, 10));
    check();
  }, ms);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const DETAILS: ContractEventDetails = {
  userId: 'user-1',
  organizationId: 'org-1',
  contractVersion: '4:x',
  services: ['acme'],
};

describe('Event ids, deduplication and resync (SPACE contract-event-ids)', () => {
  const space = new MockSpace();
  let contractSockets: ServerSocket[] = [];

  beforeAll(async () => {
    await space.start();
    const nsp = space.io.of('/contracts');
    nsp.use((socket, next) =>
      socket.handshake.auth?.apiKey === API_KEY ? next() : next(new Error('Invalid API key'))
    );
    nsp.on('connection', socket => {
      contractSockets.push(socket);
      socket.on('disconnect', () => {
        contractSockets = contractSockets.filter(s => s !== socket);
      });
    });
  });

  afterAll(async () => {
    await space.stop();
  });

  function emitContract(payload: Record<string, unknown>) {
    space.io.of('/contracts').emit('message', payload);
  }

  async function connectedClient(
    extra: Partial<SpaceConnectionOptions> = {}
  ): Promise<SpaceClient> {
    const client = new SpaceClient({ url: space.url, apiKey: API_KEY, ...extra });
    await waitFor<void>(resolve => client.on('synchronized', () => resolve()));
    return client;
  }

  /** Registers a recording listener for contract_novated and waits for the namespace. */
  async function recordNovations(client: SpaceClient) {
    const calls: { details: ContractEventDetails; meta: SpaceEventMeta }[] = [];
    client.on('contract_novated', (details, meta) => {
      calls.push({ details, meta });
    });
    await until(() => contractSockets.length > 0);
    return calls;
  }

  it('Should pass eventId and occurredAt (parsed, raw kept) as the second listener argument', async () => {
    const client = await connectedClient();
    try {
      const calls = await recordNovations(client);
      emitContract({
        code: 'CONTRACT_NOVATED',
        eventId: '019a2a6b-7c1e-7d3f-9b2a-5c4e8f1a2b3c',
        occurredAt: '2026-10-27T10:00:00.123Z',
        details: DETAILS,
      });
      await until(() => calls.length === 1);

      expect(calls[0].details).toEqual(DETAILS);
      expect(calls[0].meta.code).toBe('CONTRACT_NOVATED');
      expect(calls[0].meta.eventId).toBe('019a2a6b-7c1e-7d3f-9b2a-5c4e8f1a2b3c');
      expect(calls[0].meta.rawOccurredAt).toBe('2026-10-27T10:00:00.123Z');
      expect(calls[0].meta.occurredAt).toBeInstanceOf(Date);
      expect(calls[0].meta.occurredAt?.toISOString()).toBe('2026-10-27T10:00:00.123Z');
    } finally {
      await client.close();
    }
  });

  it('Should leave occurredAt undefined when it is missing or not a date', async () => {
    const client = await connectedClient();
    try {
      const calls = await recordNovations(client);
      emitContract({ code: 'CONTRACT_NOVATED', details: DETAILS });
      emitContract({
        code: 'CONTRACT_NOVATED',
        eventId: '019a2a6b-0000-7000-8000-000000000001',
        occurredAt: 'not a date',
        details: DETAILS,
      });
      await until(() => calls.length === 2);

      expect(calls[0].meta).toEqual({ code: 'CONTRACT_NOVATED' });
      expect(calls[1].meta.occurredAt).toBeUndefined();
      expect(calls[1].meta.rawOccurredAt).toBe('not a date');
    } finally {
      await client.close();
    }
  });

  it('Should call the listener once for a repeated contract eventId', async () => {
    const client = await connectedClient();
    try {
      const calls = await recordNovations(client);
      const event = {
        code: 'CONTRACT_NOVATED',
        eventId: '019a2a6b-0000-7000-8000-00000000000a',
        occurredAt: '2026-10-27T10:00:00.000Z',
        details: DETAILS,
      };
      emitContract(event);
      emitContract(event);
      emitContract({ ...event, eventId: '019a2a6b-0000-7000-8000-00000000000b' });
      await until(() => calls.length >= 2);
      await sleep(100);

      expect(calls.map(c => c.meta.eventId)).toEqual([
        '019a2a6b-0000-7000-8000-00000000000a',
        '019a2a6b-0000-7000-8000-00000000000b',
      ]);
    } finally {
      await client.close();
    }
  });

  it('Should drop a repeated eventId on the pricings namespace too', async () => {
    const client = await connectedClient();
    try {
      const calls: { details: PricingEventDetails; meta: SpaceEventMeta }[] = [];
      client.on('pricing_created', (details, meta) => {
        calls.push({ details, meta });
      });
      const event = {
        code: 'PRICING_CREATED',
        eventId: '019a2a6b-0000-7000-8000-0000000000p1',
        occurredAt: '2026-10-27T10:00:00.000Z',
        details: { serviceName: 'acme', pricingVersion: '2025' },
      };
      space.io.of('/pricings').emit('message', event);
      space.io.of('/pricings').emit('message', event);
      await until(() => calls.length >= 1);
      await sleep(100);

      expect(calls).toHaveLength(1);
      expect(calls[0].details).toEqual({ serviceName: 'acme', pricingVersion: '2025' });
      expect(calls[0].meta.eventId).toBe('019a2a6b-0000-7000-8000-0000000000p1');
    } finally {
      await client.close();
    }
  });

  it('Should pass through events without eventId (older SPACE), even if identical', async () => {
    const client = await connectedClient();
    try {
      const calls = await recordNovations(client);
      emitContract({ code: 'CONTRACT_NOVATED', details: DETAILS });
      emitContract({ code: 'CONTRACT_NOVATED', details: DETAILS });
      await until(() => calls.length === 2);

      expect(calls[0].meta.eventId).toBeUndefined();
      expect(calls[1].meta.eventId).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it('Should deliver repeats when deduplication is turned off', async () => {
    const client = await connectedClient({ eventDeduplication: false });
    try {
      const calls = await recordNovations(client);
      const event = { code: 'CONTRACT_NOVATED', eventId: 'same-id', details: DETAILS };
      emitContract(event);
      emitContract(event);
      await until(() => calls.length === 2);
    } finally {
      await client.close();
    }
  });

  it('Should forget the oldest ids beyond maxEntries', async () => {
    const client = await connectedClient({ eventDeduplication: { maxEntries: 2 } });
    try {
      const calls = await recordNovations(client);
      for (const eventId of ['a', 'b', 'c', 'a', 'c']) {
        emitContract({ code: 'CONTRACT_NOVATED', eventId, details: DETAILS });
      }
      await until(() => calls.length >= 4);
      await sleep(100);

      // 'a' was evicted by 'c' (window of 2: b, c), so its repeat is delivered; 'c' is still known.
      expect(calls.map(c => c.meta.eventId)).toEqual(['a', 'b', 'c', 'a']);
    } finally {
      await client.close();
    }
  });

  it('Should keep the deduplication option when the client is created with connect()', async () => {
    const client = connect({ url: space.url, apiKey: API_KEY, eventDeduplication: false });
    try {
      await waitFor<void>(resolve => client.on('synchronized', () => resolve()));
      const calls = await recordNovations(client);
      const event = { code: 'CONTRACT_NOVATED', eventId: 'connect-id', details: DETAILS };
      emitContract(event);
      emitContract(event);
      await until(() => calls.length === 2);
    } finally {
      await client.close();
    }
  });

  it('Should emit resync on the first connection and again after a reconnection', async () => {
    const client = await connectedClient();
    try {
      const resyncs: ResyncInfo[] = [];
      client.on('resync', info => {
        resyncs.push(info);
      });
      await recordNovations(client);
      await until(() => resyncs.some(r => r.namespace === 'contracts'));
      expect(resyncs).toContainEqual({ namespace: 'contracts', reconnect: false });

      // Drop the transport: socket.io-client reconnects both namespaces on its own.
      resyncs.length = 0;
      contractSockets[0].conn.close();
      await until(
        () =>
          resyncs.some(r => r.namespace === 'contracts') &&
          resyncs.some(r => r.namespace === 'pricings'),
        6000
      );
      expect(resyncs).toContainEqual({ namespace: 'contracts', reconnect: true });
      expect(resyncs).toContainEqual({ namespace: 'pricings', reconnect: true });
    } finally {
      await client.close();
    }
  }, 10000);

  it('Should invalidate the cached user data after the contracts namespace reconnects', async () => {
    const client = await connectedClient({
      cache: { enabled: true, type: CacheType.BUILTIN, ttl: 300 },
    });
    try {
      const cache = client.getCache();
      await until(() => cache.isEnabled());
      const resyncs: ResyncInfo[] = [];
      let cachedAtResync: unknown = 'not called';
      client.on('resync', async info => {
        if (info.namespace === 'contracts' && info.reconnect) {
          cachedAtResync = await cache.get(cache.getContractKey('user-7'));
        }
        resyncs.push(info);
      });
      await recordNovations(client);
      await until(() => resyncs.some(r => r.namespace === 'contracts'));
      await cache.set(cache.getContractKey('user-7'), { stale: true });
      await cache.set(cache.getPricingTokenKey('user-8'), 'stale-token');
      await cache.set(cache.getFeatureKey('user-8', 'acme-storage'), { eval: true });

      contractSockets[0].conn.close();
      await until(() => resyncs.some(r => r.namespace === 'contracts' && r.reconnect), 6000);

      // Invalidated before the resync listener runs.
      expect(cachedAtResync).toBeNull();
      expect(await cache.get(cache.getPricingTokenKey('user-8'))).toBeNull();
      expect(await cache.get(cache.getFeatureKey('user-8', 'acme-storage'))).toBeNull();
    } finally {
      await client.close();
    }
  }, 10000);

  it('Should type the listener arguments', () => {
    expectTypeOf<SpaceEventMeta['eventId']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SpaceEventMeta['occurredAt']>().toEqualTypeOf<Date | undefined>();
    expectTypeOf<SpaceEventMeta['rawOccurredAt']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ResyncInfo['namespace']>().toEqualTypeOf<'contracts' | 'pricings'>();
    expectTypeOf<ResyncInfo['reconnect']>().toEqualTypeOf<boolean>();
  });
});

describe('EventIdWindow', () => {
  it('Should accept an id once and reject repeats', () => {
    const window = new EventIdWindow();
    expect(window.accept('x')).toBe(true);
    expect(window.accept('x')).toBe(false);
    expect(window.accept('y')).toBe(true);
    expect(window.size).toBe(2);
  });

  it('Should forget ids older than windowMs', () => {
    let now = 0;
    const window = new EventIdWindow({ windowMs: 1000 }, () => now);
    expect(window.accept('x')).toBe(true);
    now = 999;
    expect(window.accept('x')).toBe(false);
    now = 1001;
    expect(window.accept('x')).toBe(true);
  });

  it('Should keep at most maxEntries ids, dropping the oldest first', () => {
    const window = new EventIdWindow({ maxEntries: 3 });
    for (const id of ['1', '2', '3', '4']) {
      expect(window.accept(id)).toBe(true);
    }
    expect(window.size).toBe(3);
    expect(window.accept('1')).toBe(true); // evicted
    expect(window.accept('4')).toBe(false);
  });

  it('Should use sensible defaults', () => {
    expect(EventIdWindow.DEFAULT_MAX_ENTRIES).toBe(10_000);
    expect(EventIdWindow.DEFAULT_WINDOW_MS).toBe(10 * 60_000);
  });

  it('Should reject invalid options', () => {
    expect(() => new EventIdWindow({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new EventIdWindow({ maxEntries: 1.5 })).toThrow(RangeError);
    expect(() => new EventIdWindow({ windowMs: 0 })).toThrow(RangeError);
    expect(() => new EventIdWindow({ windowMs: Number.NaN })).toThrow(RangeError);
  });
});
