import { describe, it, expect, beforeAll, afterAll, afterEach, expectTypeOf } from 'vitest';
import type { Socket as ServerSocket } from 'socket.io';
import {
  CacheType,
  ContractEventDetails,
  PricingTokenPayload,
  PricingTokenSubscription,
  SpaceClient,
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
  const handshakes: { apiKey?: string; header?: string }[] = [];
  let contractSockets: ServerSocket[] = [];

  beforeAll(async () => {
    await space.start();
    const nsp = space.io.of('/contracts');
    nsp.use((socket, next) => {
      const apiKey = socket.handshake.auth?.apiKey;
      handshakes.push({ apiKey, header: socket.handshake.headers['x-api-key'] as string });
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

  async function connectedClient(apiKey = API_KEY, withCache = false): Promise<SpaceClient> {
    const client = new SpaceClient({
      url: space.url,
      apiKey,
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
