import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, SpaceClient } from '../../main/index';
import { CacheType, SpaceConnectionOptions } from '../../main/types';

// The options every SpaceClient built during the test received, in order.
const constructed = vi.hoisted(() => [] as unknown[]);

// The real SpaceClient, recording the options it is constructed with.
vi.mock('../../main/config/SpaceClient', async importOriginal => {
  const actual = await importOriginal<typeof import('../../main/config/SpaceClient')>();
  class RecordingSpaceClient extends actual.SpaceClient {
    constructor(options: SpaceConnectionOptions) {
      constructed.push(options);
      super(options);
    }
  }
  return { ...actual, SpaceClient: RecordingSpaceClient };
});

// Nothing listens here: the client only tries to open its socket, and no HTTP call is made.
const UNREACHABLE_SPACE_URL = 'http://127.0.0.1:9';

describe('connect() connection options', () => {
  const clients: SpaceClient[] = [];

  function connectAndTrack(options: SpaceConnectionOptions): SpaceClient {
    const client = connect(options);
    clients.push(client);
    return client;
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      // disconnect() does nothing while the socket has never connected; stop its reconnection loop.
      (client as any).pricingSocketNamespace.disconnect();
      await client.close();
    }
    constructed.length = 0;
  });

  it('passes every SpaceConnectionOptions field on to SpaceClient', () => {
    // `satisfies Required<...>`: a new option must be added here (and to connect()) to compile.
    const options = {
      url: UNREACHABLE_SPACE_URL,
      apiKey: 'test-api-key',
      timeout: 1234,
      cache: { enabled: true, type: CacheType.BUILTIN, ttl: 60 },
    } satisfies Required<SpaceConnectionOptions>;

    connectAndTrack(options);

    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toEqual(options);
  });

  it('enables the cache configured through connect()', async () => {
    const client = connectAndTrack({
      url: UNREACHABLE_SPACE_URL,
      apiKey: 'test-api-key',
      cache: { enabled: true },
    });

    await vi.waitFor(() => expect(client.getCache().isEnabled()).toBe(true));
    await client.getCache().set('connect-options-key', 'cached');
    expect(await client.getCache().get('connect-options-key')).toBe('cached');
  });

  it('leaves the cache off when it is disabled or not configured', () => {
    const disabled = connectAndTrack({
      url: UNREACHABLE_SPACE_URL,
      apiKey: 'test-api-key',
      cache: { enabled: false },
    });
    const notConfigured = connectAndTrack({ url: UNREACHABLE_SPACE_URL, apiKey: 'test-api-key' });

    expect(disabled.getCache().isEnabled()).toBe(false);
    expect(notConfigured.getCache().isEnabled()).toBe(false);
  });

  it('keeps url, apiKey and the 5000 ms default timeout', () => {
    const client = connectAndTrack({ url: UNREACHABLE_SPACE_URL, apiKey: 'test-api-key' });

    expect(client.httpUrl).toBe(`${UNREACHABLE_SPACE_URL}/api/v1`);
    expect(client.apiKey).toBe('test-api-key');
    expect(client.timeout).toBe(5000);
  });
});
