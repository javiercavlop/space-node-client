import { describe, it, expect, beforeAll, afterAll, afterEach, expectTypeOf } from 'vitest';
import type { Socket as ServerSocket } from 'socket.io';
import {
  CacheType,
  ContractEventDetails,
  PricingTokenPayload,
  PricingTokenSubscription,
  SpaceClient,
  connect,
} from '../../main/index';
import { MockSpace } from './mockSpace';

const API_KEY = 'test-org-key';

function waitFor<T>(register: (resolve: (value: T) => void) => void, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for event')), ms);
    register(value => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

describe('Contract events against a mocked SPACE (S6)', () => {
  const space = new MockSpace();
  const USER_KEY = 'usr_member-key';
  const handshakes: { apiKey?: string; organizationId?: string; header?: string }[] = [];
  let contractSockets: ServerSocket[] = [];

  beforeAll(async () => {
    await space.start();
    const nsp = space.io.of('/contracts');
    nsp.use((socket, next) => {
      const apiKey = socket.handshake.auth?.apiKey;
      const organizationId = socket.handshake.auth?.organizationId;
      handshakes.push({
        apiKey,
        organizationId,
        header: socket.handshake.headers['x-api-key'] as string,
      });
      // Like SPACE: org keys alone; member user keys (usr_) need the organisation.
      if (apiKey === USER_KEY) {
        return organizationId ? next() : next(new Error('organizationId is required for user keys'));
      }
      if (apiKey !== API_KEY) {
        return next(new Error('Invalid API key'));
      }
      next();
    });
    nsp.on('connection', socket => {
      contractSockets.push(socket);
      socket.on('disconnect', () => {
        contractSockets = contractSockets.filter(s => s !== socket);
      });
    });
  });

  afterEach(() => {
    handshakes.length = 0;
  });

  afterAll(async () => {
    await space.stop();
  });

  function emitContractEvent(code: string, details: ContractEventDetails) {
    space.io.of('/contracts').emit('message', { code, details });
  }

  async function connectedClient(
    apiKey = API_KEY,
    withCache = false,
    organizationId?: string
  ): Promise<SpaceClient> {
    const client = new SpaceClient({
      url: space.url,
      apiKey,
      organizationId,
      cache: withCache ? { enabled: true, type: CacheType.BUILTIN, ttl: 300 } : undefined,
    });
    await waitFor<void>(resolve => client.on('synchronized', () => resolve()));
    return client;
  }

  it('Should not open the contracts namespace until a contract listener is registered', async () => {
    const client = await connectedClient();
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(handshakes).toHaveLength(0);

      const details: ContractEventDetails = {
        userId: 'user-1',
        organizationId: 'org-1',
        contractVersion: '4:x',
        services: ['acme'],
      };
      const received = waitFor<ContractEventDetails>(resolve =>
        client.on('contract_novated', data => resolve(data))
      );
      await waitFor<void>(resolve => {
        const check = () => (contractSockets.length > 0 ? resolve() : setTimeout(check, 10));
        check();
      });

      expect(handshakes[0].apiKey).toBe(API_KEY);
      // Org keys: the handshake carries only the key.
      expect(handshakes[0]).not.toHaveProperty('organizationId', expect.anything());
      emitContractEvent('CONTRACT_NOVATED', details);
      expect(await received).toEqual(details);
    } finally {
      await client.close();
    }
  });

  it('Should dispatch every contract event code to its listener', async () => {
    const client = await connectedClient();
    try {
      const names = [
        'contract_created',
        'contract_novated',
        'contract_deleted',
        'contract_renewed',
      ];
      const received: Record<string, ContractEventDetails> = {};
      const all = Promise.all(
        names.map(name =>
          waitFor<void>(resolve =>
            client.on(name as any, (data: ContractEventDetails) => {
              received[name] = data;
              resolve();
            })
          )
        )
      );
      await waitFor<void>(resolve => {
        const check = () => (contractSockets.length > 0 ? resolve() : setTimeout(check, 10));
        check();
      });

      for (const name of names) {
        emitContractEvent(name.toUpperCase(), {
          userId: name,
          organizationId: 'org-1',
          contractVersion: '1:x',
          services: ['acme'],
        });
      }
      await all;

      for (const name of names) {
        expect(received[name].userId).toBe(name);
      }
    } finally {
      await client.close();
    }
  });

  it('Should keep pricing events on the pricings namespace working', async () => {
    const client = await connectedClient();
    try {
      const received = waitFor<any>(resolve => client.on('pricing_created', data => resolve(data)));
      space.io.of('/pricings').emit('message', {
        code: 'PRICING_CREATED',
        details: { serviceName: 'acme', pricingVersion: '2025-01-10' },
      });
      expect(await received).toEqual({ serviceName: 'acme', pricingVersion: '2025-01-10' });
      expect(handshakes).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it('Should invalidate the cached data of the affected user', async () => {
    const client = await connectedClient(API_KEY, true);
    try {
      const cache = client.getCache();
      await cache.set(cache.getContractKey('user-9'), { stale: true });
      await cache.set(cache.getPricingTokenKey('user-9'), 'stale-token');
      await cache.set(cache.getContractKey('user-10'), { untouched: true });

      const received = waitFor<void>(resolve => client.on('contract_novated', () => resolve()));
      await waitFor<void>(resolve => {
        const check = () => (contractSockets.length > 0 ? resolve() : setTimeout(check, 10));
        check();
      });
      emitContractEvent('CONTRACT_NOVATED', {
        userId: 'user-9',
        organizationId: 'org-1',
        contractVersion: '2:x',
        services: ['acme'],
      });
      await received;

      expect(await cache.get(cache.getContractKey('user-9'))).toBeNull();
      expect(await cache.get(cache.getPricingTokenKey('user-9'))).toBeNull();
      expect(await cache.get(cache.getContractKey('user-10'))).toEqual({ untouched: true });
    } finally {
      await client.close();
    }
  });

  it('Should report a rejected contracts handshake through the error listener', async () => {
    const client = await connectedClient('wrong-key');
    try {
      const error = waitFor<any>(resolve => client.on('error', e => resolve(e)));
      client.on('contract_created', () => undefined);

      expect((await error).message).toBe('Invalid API key');
    } finally {
      await client.close();
    }
  });

  it('Should close the contracts namespace on disconnect()', async () => {
    const client = await connectedClient();
    try {
      client.on('contract_deleted', () => undefined);
      await waitFor<void>(resolve => {
        const check = () => (contractSockets.length > 0 ? resolve() : setTimeout(check, 10));
        check();
      });

      client.disconnect();

      await waitFor<void>(resolve => {
        const check = () => (contractSockets.length === 0 ? resolve() : setTimeout(check, 10));
        check();
      });
      expect(contractSockets).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it('Should send organizationId in the handshake when connecting with a member user key', async () => {
    const client = await connectedClient(USER_KEY, false, 'org-1');
    try {
      const received = waitFor<ContractEventDetails>(resolve =>
        client.on('contract_created', data => resolve(data))
      );
      await waitFor<void>(resolve => {
        const check = () => (contractSockets.length > 0 ? resolve() : setTimeout(check, 10));
        check();
      });

      expect(handshakes[0]).toEqual({ apiKey: USER_KEY, organizationId: 'org-1', header: undefined });
      const details: ContractEventDetails = {
        userId: 'user-9',
        organizationId: 'org-1',
        contractVersion: '1:x',
        services: ['acme'],
      };
      emitContractEvent('CONTRACT_CREATED', details);
      expect(await received).toEqual(details);
    } finally {
      await client.close();
    }
  });

  it('Should keep organizationId when the client is created with connect()', async () => {
    const client = connect({ url: space.url, apiKey: USER_KEY, organizationId: 'org-1' });
    try {
      expect(client.organizationId).toBe('org-1');
    } finally {
      await client.close();
    }
  });

  it('Should report a user-key handshake without organizationId through the error listener', async () => {
    const client = await connectedClient(USER_KEY);
    try {
      const error = waitFor<Error>(resolve => client.on('error', e => resolve(e)));
      client.on('contract_novated', () => undefined);

      expect((await error).message).toMatch(/organizationId/);
    } finally {
      await client.close();
    }
  });

  it('Should deliver contract_deleted with a null contractVersion', async () => {
    const client = await connectedClient();
    try {
      const received = waitFor<ContractEventDetails>(resolve =>
        client.on('contract_deleted', data => resolve(data))
      );
      await waitFor<void>(resolve => {
        const check = () => (contractSockets.length > 0 ? resolve() : setTimeout(check, 10));
        check();
      });

      const details: ContractEventDetails = {
        userId: 'user-1',
        organizationId: 'org-1',
        contractVersion: null,
        services: ['acme'],
      };
      emitContractEvent('CONTRACT_DELETED', details);
      expect((await received).contractVersion).toBeNull();
      expectTypeOf<ContractEventDetails['contractVersion']>().toEqualTypeOf<string | null>();
    } finally {
      await client.close();
    }
  });
});

describe('Pricing token subscription types (S7)', () => {
  it('Should type the optional subscription claim of the pricing token', () => {
    const payload: PricingTokenPayload = {
      sub: 'user-1',
      iat: 1,
      exp: 2,
      features: { 'acme-storage': { eval: true, used: null, limit: null, error: null } },
      pricingContext: {
        features: { 'acme-storage': true },
        usageLimits: { 'acme-maxStorage': 10 },
      },
      subscriptionContext: { 'acme-maxStorage': 2 },
      subscription: {
        contractedServices: { acme: '2025-01-10' },
        subscriptionPlans: { acme: 'pro' },
        subscriptionAddOns: { acme: { extraStorage: 1 } },
        contractVersion: '4:x',
      },
    };

    expectTypeOf(payload.subscription).toEqualTypeOf<PricingTokenSubscription | undefined>();
    expectTypeOf<PricingTokenSubscription['contractVersion']>().toEqualTypeOf<string>();
    // Tokens issued by SPACE versions without S7 have no subscription claim.
    const legacy: PricingTokenPayload = { sub: 'u', iat: 1, exp: 2, features: {} };
    expect(legacy.subscription).toBeUndefined();
  });
});
