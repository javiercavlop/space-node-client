import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { CacheType, ContractChangedError, NovationPreview, SpaceClient } from '../../main/index';
import { MockSpace } from './mockSpace';

const API_KEY = 'test-org-key';

const SUBSCRIPTION = {
  contractedServices: { acme: '2025-01-10' },
  subscriptionPlans: { acme: 'pro' },
  subscriptionAddOns: { acme: { extraStorage: 1 } },
};

function contract(contractVersion: string, plan = 'pro') {
  return {
    userContact: { userId: 'user-1', username: 'user1' },
    billingPeriod: {
      startDate: '2026-10-01T00:00:00.000Z',
      endDate: '2026-10-31T00:00:00.000Z',
      autoRenew: true,
      renewalDays: 30,
    },
    usageLevels: {},
    contractedServices: { acme: '2025-01-10' },
    subscriptionPlans: { acme: plan },
    subscriptionAddOns: { acme: { extraStorage: 1 } },
    history: [],
    contractVersion,
  };
}

describe('Novation against a mocked SPACE (S4, S5, S8)', () => {
  const space = new MockSpace();
  let client: SpaceClient;

  beforeAll(async () => {
    await space.start();
    client = new SpaceClient({
      url: space.url,
      apiKey: API_KEY,
      cache: { enabled: true, type: CacheType.BUILTIN, ttl: 300 },
    });
    // Cache initialisation is asynchronous in the constructor.
    await new Promise(resolve => setTimeout(resolve, 50));
  });

  afterEach(() => {
    space.reset();
  });

  afterAll(async () => {
    await client.close();
    await space.stop();
  });

  describe('contracts.previewNovation (S4)', () => {
    it('Should POST the subscription to the preview endpoint and return the dry-run result', async () => {
      const preview: NovationPreview = {
        valid: true,
        errors: [],
        effective: SUBSCRIPTION,
        versionChanges: {
          acme: { from: '2024-06-08', to: '2025-01-10', reason: 'policy:all_last' },
        },
        usageWarnings: [{ service: 'acme', usageLimit: 'storage', consumed: 42, newLimit: 10 }],
        billingPeriod: {
          startDate: '2026-10-27T00:00:00.000Z',
          endDate: '2026-11-26T00:00:00.000Z',
          restarts: true,
        },
        contractVersion: '3:2026-10-27T10:00:00.000Z',
      };
      space.route('POST', '/contracts/user-1/novation/preview', { status: 200, body: preview });

      const result = await client.contracts.previewNovation('user-1', SUBSCRIPTION);

      expect(result).toEqual(preview);
      const req = space.lastRequest();
      expect(req.body).toEqual(SUBSCRIPTION);
      expect(req.headers['x-api-key']).toBe(API_KEY);
      expect(req.query.has('keepBillingPeriod')).toBe(false);
    });

    it('Should allow omitting contractedServices and pass keepBillingPeriod as a query flag', async () => {
      space.route('POST', '/contracts/user-1/novation/preview', {
        status: 200,
        body: {
          valid: true,
          errors: [],
          effective: SUBSCRIPTION,
          versionChanges: {},
          usageWarnings: [],
          billingPeriod: {
            startDate: '2026-10-01T00:00:00.000Z',
            endDate: '2026-10-31T00:00:00.000Z',
            restarts: false,
          },
          contractVersion: '3:x',
        },
      });

      const result = await client.contracts.previewNovation(
        'user-1',
        { subscriptionPlans: { acme: 'pro' }, subscriptionAddOns: {} },
        { keepBillingPeriod: true }
      );

      const req = space.lastRequest();
      expect(req.query.get('keepBillingPeriod')).toBe('true');
      expect(req.body).toEqual({ subscriptionPlans: { acme: 'pro' }, subscriptionAddOns: {} });
      expect(result.billingPeriod.restarts).toBe(false);
    });

    it('Should return valid:false results (HTTP 200) instead of throwing', async () => {
      space.route('POST', '/contracts/user-1/novation/preview', {
        status: 200,
        body: {
          valid: false,
          errors: [
            {
              code: 'ADDON_NOT_AVAILABLE',
              service: 'acme',
              path: 'subscriptionAddOns.acme.extraStorage',
              message: 'extraStorage is not available for plan free',
            },
          ],
          effective: SUBSCRIPTION,
          versionChanges: {},
          usageWarnings: [],
          billingPeriod: { startDate: 'a', endDate: 'b', restarts: true },
          contractVersion: '3:x',
        },
      });

      const result = await client.contracts.previewNovation('user-1', SUBSCRIPTION);

      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('ADDON_NOT_AVAILABLE');
    });

    it('Should not touch the cached contract', async () => {
      const cache = client.getCache();
      await cache.set(cache.getContractKey('user-1'), contract('1:cached'));
      space.route('POST', '/contracts/user-1/novation/preview', {
        status: 200,
        body: { valid: true, errors: [], contractVersion: '1:cached' },
      });

      await client.contracts.previewNovation('user-1', SUBSCRIPTION);

      expect(await cache.get(cache.getContractKey('user-1'))).toEqual(contract('1:cached'));
    });
  });

  describe('contracts.updateContractSubscription (S5, S8)', () => {
    it('Should behave as before when no options are given', async () => {
      space.route('PUT', '/contracts/user-1', { status: 200, body: contract('4:x') });

      const result = await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION);

      const req = space.lastRequest();
      expect(req.body).toEqual(SUBSCRIPTION);
      expect(req.headers['if-match']).toBeUndefined();
      expect(req.query.has('keepBillingPeriod')).toBe(false);
      expect(result.contractVersion).toBe('4:x');
    });

    it('Should send If-Match with the expected contract version and keepBillingPeriod', async () => {
      space.route('PUT', '/contracts/user-1', req => {
        expect(req.headers['if-match']).toBe('"3:2026-10-27T10:00:00.000Z"');
        return {
          status: 200,
          body: contract('4:2026-10-27T10:05:00.000Z'),
          headers: { etag: '"4:2026-10-27T10:05:00.000Z"' },
        };
      });

      const result = await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION, {
        expectedContractVersion: '3:2026-10-27T10:00:00.000Z',
        keepBillingPeriod: true,
      });

      const req = space.lastRequest();
      expect(req.query.get('keepBillingPeriod')).toBe('true');
      // The body stays exactly the subscription: older SPACE versions keep accepting it.
      expect(req.body).toEqual(SUBSCRIPTION);
      expect(result.contractVersion).toBe('4:2026-10-27T10:05:00.000Z');
    });

    it('Should cache the novated contract', async () => {
      space.route('PUT', '/contracts/user-1', { status: 200, body: contract('5:x', 'enterprise') });

      await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION);

      const cache = client.getCache();
      const cached = await cache.get<any>(cache.getContractKey('user-1'));
      expect(cached.subscriptionPlans.acme).toBe('enterprise');
    });

    it('Should throw ContractChangedError with the current contractVersion on 412', async () => {
      const cache = client.getCache();
      await cache.set(cache.getContractKey('user-1'), contract('3:stale'));
      await cache.set(cache.getPricingTokenKey('user-1'), 'stale-token');
      space.route('PUT', '/contracts/user-1', {
        status: 412,
        body: { error: 'CONTRACT_CHANGED', contractVersion: '4:current' },
      });

      const error = await client.contracts
        .updateContractSubscription('user-1', SUBSCRIPTION, { expectedContractVersion: '3:stale' })
        .catch(e => e);

      expect(error).toBeInstanceOf(ContractChangedError);
      expect(error.code).toBe('CONTRACT_CHANGED');
      expect(error.userId).toBe('user-1');
      expect(error.expectedContractVersion).toBe('3:stale');
      expect(error.contractVersion).toBe('4:current');
      // The cached copy is known to be stale: it must not be served again.
      expect(await cache.get(cache.getContractKey('user-1'))).toBeNull();
      expect(await cache.get(cache.getPricingTokenKey('user-1'))).toBeNull();
    });

    it('Should fall back to the ETag header when the 412 body has no contractVersion', async () => {
      space.route('PUT', '/contracts/user-1', {
        status: 412,
        body: { error: 'CONTRACT_CHANGED' },
        headers: { etag: '"7:etag"' },
      });

      const error = await client.contracts
        .updateContractSubscription('user-1', SUBSCRIPTION, { expectedContractVersion: '6:x' })
        .catch(e => e);

      expect(error).toBeInstanceOf(ContractChangedError);
      expect(error.contractVersion).toBe('7:etag');
    });

    it('Should not quote an expected version that already is an ETag', async () => {
      space.route('PUT', '/contracts/user-1', { status: 200, body: contract('9:x') });

      await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION, {
        expectedContractVersion: '"8:x"',
      });

      expect(space.lastRequest().headers['if-match']).toBe('"8:x"');
    });

    it('Should keep rethrowing other errors (400 invalid subscription)', async () => {
      space.route('PUT', '/contracts/user-1', {
        status: 400,
        body: { error: 'Invalid subscription: PRIVATE_PLAN' },
      });

      const error = await client.contracts
        .updateContractSubscription('user-1', SUBSCRIPTION)
        .catch(e => e);

      expect(error).not.toBeInstanceOf(ContractChangedError);
      expect(error.response.status).toBe(400);
    });
  });
});
