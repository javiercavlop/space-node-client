import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  CacheType,
  ContractChangedError,
  NovationPreview,
  SpaceClient,
  SpaceFeatureUnsupportedError,
} from '../../main/index';
import { MockSpace } from './mockSpace';

const API_KEY = 'test-org-key';

const SUBSCRIPTION = {
  contractedServices: { acme: '2025-01-10' },
  subscriptionPlans: { acme: 'pro' },
  subscriptionAddOns: { acme: { extraStorage: 1 } },
};

const ALL_CAPABILITIES = ['contract-version', 'keep-billing-period'];

function contract(
  contractVersion: string | undefined,
  plan = 'pro',
  startDate = '2026-10-01T00:00:00.000Z'
) {
  return {
    userContact: { userId: 'user-1', username: 'user1' },
    billingPeriod: {
      startDate,
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

  afterEach(async () => {
    space.reset();
    client.clearCapabilities();
    await client.getCache().invalidateUser('user-1');
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await client.close();
    await space.stop();
  });

  /** Serves the current contract (the pre-write check reads it when capabilities are not cached). */
  function serveContract(contractVersion: string, startDate?: string) {
    space.route('GET', '/contracts/user-1', {
      status: 200,
      body: contract(contractVersion, 'pro', startDate),
      headers: { etag: `"${contractVersion}"` },
    });
  }

  function puts() {
    return space.requests.filter(r => r.method === 'PUT');
  }

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
      space.capabilities = ALL_CAPABILITIES;
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

    it('Should refuse a keepBillingPeriod preview from a SPACE without keep-billing-period', async () => {
      space.capabilities = ['novation-preview'];
      space.route('POST', '/contracts/user-1/novation/preview', {
        status: 200,
        body: { valid: true, errors: [], billingPeriod: { restarts: true }, contractVersion: '3:x' },
      });

      const error = await client.contracts
        .previewNovation('user-1', SUBSCRIPTION, { keepBillingPeriod: true })
        .catch(e => e);

      expect(error).toBeInstanceOf(SpaceFeatureUnsupportedError);
      expect(error.capability).toBe('keep-billing-period');
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

      // No capability check: a single request, identical to 0.3.0.
      expect(space.requests).toHaveLength(1);
      const req = space.lastRequest();
      expect(req.body).toEqual(SUBSCRIPTION);
      expect(req.headers['if-match']).toBeUndefined();
      expect(req.query.has('keepBillingPeriod')).toBe(false);
      expect(result.contractVersion).toBe('4:x');
    });

    it('Should send If-Match with the expected contract version and keepBillingPeriod', async () => {
      space.capabilities = ALL_CAPABILITIES;
      serveContract('3:2026-10-27T10:00:00.000Z');
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
      // The pre-write read still sees the expected version; the contract changes before the PUT.
      space.capabilities = ALL_CAPABILITIES;
      serveContract('3:stale');
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
      space.capabilities = ALL_CAPABILITIES;
      serveContract('6:x');
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
      space.capabilities = ALL_CAPABILITIES;
      serveContract('8:x');
      space.route('PUT', '/contracts/user-1', {
        status: 200,
        body: contract('9:x'),
        headers: { etag: '"9:x"' },
      });

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
  describe('capability check against older SPACE versions (S0)', () => {
    it('Should refuse expectedContractVersion without writing when SPACE lacks contract-version', async () => {
      // SPACE 1.7: no X-Space-Capabilities header, If-Match would be ignored.
      serveContract('3:x');
      space.route('PUT', '/contracts/user-1', { status: 200, body: contract(undefined) });

      const error = await client.contracts
        .updateContractSubscription('user-1', SUBSCRIPTION, { expectedContractVersion: '3:x' })
        .catch(e => e);

      expect(error).toBeInstanceOf(SpaceFeatureUnsupportedError);
      expect(error.code).toBe('SPACE_FEATURE_UNSUPPORTED');
      expect(error.capability).toBe('contract-version');
      expect(error.written).toBe(false);
      expect(puts()).toHaveLength(0);
    });

    it('Should refuse keepBillingPeriod without writing when SPACE lacks keep-billing-period', async () => {
      serveContract('3:x');
      space.route('PUT', '/contracts/user-1', { status: 200, body: contract(undefined) });

      const error = await client.contracts
        .updateContractSubscription('user-1', SUBSCRIPTION, { keepBillingPeriod: true })
        .catch(e => e);

      expect(error).toBeInstanceOf(SpaceFeatureUnsupportedError);
      expect(error.capability).toBe('keep-billing-period');
      expect(error.written).toBe(false);
      expect(puts()).toHaveLength(0);
    });

    it('Should refuse when only one of the two required capabilities is advertised', async () => {
      space.capabilities = ['contract-org-scope', 'contract-version'];
      serveContract('3:x');

      const error = await client.contracts
        .updateContractSubscription('user-1', SUBSCRIPTION, {
          expectedContractVersion: '3:x',
          keepBillingPeriod: true,
        })
        .catch(e => e);

      expect(error).toBeInstanceOf(SpaceFeatureUnsupportedError);
      expect(error.capability).toBe('keep-billing-period');
      expect(puts()).toHaveLength(0);
    });

    it('Should throw ContractChangedError early when the current ETag differs', async () => {
      space.capabilities = ALL_CAPABILITIES;
      serveContract('5:new');
      const cache = client.getCache();
      await cache.set(cache.getContractKey('user-1'), contract('4:old'));

      const error = await client.contracts
        .updateContractSubscription('user-1', SUBSCRIPTION, { expectedContractVersion: '4:old' })
        .catch(e => e);

      expect(error).toBeInstanceOf(ContractChangedError);
      expect(error.expectedContractVersion).toBe('4:old');
      expect(error.contractVersion).toBe('5:new');
      expect(puts()).toHaveLength(0);
      expect(await cache.get(cache.getContractKey('user-1'))).toBeNull();
    });

    it('Should cache the capabilities per client for a short time', async () => {
      space.capabilities = ALL_CAPABILITIES;
      serveContract('3:x');
      space.route('PUT', '/contracts/user-1', {
        status: 200,
        body: contract('3:x'),
        headers: { etag: '"3:x"' },
      });
      const options = { expectedContractVersion: '3:x' };
      const gets = () => space.requests.filter(r => r.method === 'GET').length;

      await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION, options);
      await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION, options);
      expect(gets()).toBe(1);

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + SpaceClient.CAPABILITIES_TTL_MS + 1);
      await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION, options);
      expect(gets()).toBe(2);
      expect(puts()).toHaveLength(3);
    });

    it('Should learn the capabilities from any earlier response', async () => {
      space.capabilities = ALL_CAPABILITIES;
      space.route('GET', '/contracts/user-1/pricings', {
        status: 200,
        body: { services: {}, contractVersion: '3:x' },
      });
      space.route('PUT', '/contracts/user-1', {
        status: 200,
        body: contract('4:x'),
        headers: { etag: '"4:x"' },
      });

      await client.contracts.getPricings('user-1');
      await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION, {
        expectedContractVersion: '3:x',
        keepBillingPeriod: true,
      });

      expect(space.requests.map(r => `${r.method} ${r.path}`)).toEqual([
        'GET /contracts/user-1/pricings',
        'PUT /contracts/user-1',
      ]);
    });

    it('Should throw after the write when the PUT response lacks the ETag (backstop)', async () => {
      // Capabilities were cached from a newer SPACE, but this response comes from one that ignored If-Match.
      space.capabilities = ALL_CAPABILITIES;
      serveContract('3:x');
      await client.contracts.getContract('user-1');
      space.capabilities = null;
      space.route('PUT', '/contracts/user-1', { status: 200, body: contract(undefined) });

      const error = await client.contracts
        .updateContractSubscription('user-1', SUBSCRIPTION, { expectedContractVersion: '3:x' })
        .catch(e => e);

      expect(error).toBeInstanceOf(SpaceFeatureUnsupportedError);
      expect(error.capability).toBe('contract-version');
      expect(error.written).toBe(true);
      expect(error.contract.subscriptionPlans.acme).toBe('pro');
      expect(puts()).toHaveLength(1);
      const cache = client.getCache();
      expect(await cache.get(cache.getContractKey('user-1'))).toBeNull();
    });

    it('Should throw after the write when keepBillingPeriod was ignored (backstop)', async () => {
      space.capabilities = ALL_CAPABILITIES;
      serveContract('3:x', '2026-10-01T00:00:00.000Z');
      // The server restarted the billing period anyway.
      space.route('PUT', '/contracts/user-1', {
        status: 200,
        body: contract('4:x', 'pro', '2026-10-27T12:00:00.000Z'),
        headers: { etag: '"4:x"' },
      });

      const error = await client.contracts
        .updateContractSubscription('user-1', SUBSCRIPTION, { keepBillingPeriod: true })
        .catch(e => e);

      expect(error).toBeInstanceOf(SpaceFeatureUnsupportedError);
      expect(error.capability).toBe('keep-billing-period');
      expect(error.written).toBe(true);
    });

    it('Should detect an ignored keepBillingPeriod from the history when no read was needed', async () => {
      space.capabilities = ALL_CAPABILITIES;
      serveContract('3:x');
      await client.contracts.getContract('user-1');
      const restarted = {
        ...contract('4:x', 'pro', '2026-10-27T12:00:00.000Z'),
        history: [
          {
            startDate: '2026-10-01T00:00:00.000Z',
            endDate: '2026-10-27T12:00:00.000Z',
            contractedServices: {},
            subscriptionPlans: {},
            subscriptionAddOns: {},
          },
        ],
      };
      space.route('PUT', '/contracts/user-1', {
        status: 200,
        body: restarted,
        headers: { etag: '"4:x"' },
      });

      const error = await client.contracts
        .updateContractSubscription('user-1', SUBSCRIPTION, { keepBillingPeriod: true })
        .catch(e => e);

      expect(space.requests.filter(r => r.method === 'GET')).toHaveLength(1);
      expect(error).toBeInstanceOf(SpaceFeatureUnsupportedError);
      expect(error.capability).toBe('keep-billing-period');
      expect(error.written).toBe(true);
    });

    it('Should accept a kept billing period', async () => {
      space.capabilities = ALL_CAPABILITIES;
      serveContract('3:x');
      const kept = {
        ...contract('4:x'),
        history: [
          {
            startDate: '2026-10-01T00:00:00.000Z',
            endDate: '2026-10-27T12:00:00.000Z',
            contractedServices: {},
            subscriptionPlans: {},
            subscriptionAddOns: {},
          },
        ],
      };
      space.route('PUT', '/contracts/user-1', {
        status: 200,
        body: kept,
        headers: { etag: '"4:x"' },
      });

      const result = await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION, {
        expectedContractVersion: '3:x',
        keepBillingPeriod: true,
      });

      expect(result.contractVersion).toBe('4:x');
    });
  });

  describe('rejectPrivate (S8, opt-in, capability reject-private)', () => {
    const WITH_REJECT_PRIVATE = [...ALL_CAPABILITIES, 'reject-private'];

    it('Should send rejectPrivate=true on the novation when SPACE advertises reject-private', async () => {
      space.capabilities = WITH_REJECT_PRIVATE;
      serveContract('3:x');
      space.route('PUT', '/contracts/user-1', {
        status: 200,
        body: contract('4:x'),
        headers: { etag: '"4:x"' },
      });

      const result = await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION, {
        expectedContractVersion: '3:x',
        keepBillingPeriod: true,
        rejectPrivate: true,
      });

      const req = puts()[0];
      expect(req.query.get('rejectPrivate')).toBe('true');
      expect(req.query.get('keepBillingPeriod')).toBe('true');
      expect(req.body).toEqual(SUBSCRIPTION);
      expect(result.contractVersion).toBe('4:x');
    });

    it('Should check rejectPrivate alone and send no other flag', async () => {
      space.capabilities = WITH_REJECT_PRIVATE;
      serveContract('3:x');
      space.route('PUT', '/contracts/user-1', { status: 200, body: contract('4:x') });

      await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION, {
        rejectPrivate: true,
      });

      // One read for the capability check, then the write.
      expect(space.requests.map(r => r.method)).toEqual(['GET', 'PUT']);
      const req = puts()[0];
      expect(req.query.get('rejectPrivate')).toBe('true');
      expect(req.query.has('keepBillingPeriod')).toBe(false);
      expect(req.headers['if-match']).toBeUndefined();
    });

    it.each([
      ['no X-Space-Capabilities header', null],
      ['the other capabilities only', ALL_CAPABILITIES],
    ])(
      'Should refuse rejectPrivate without writing when SPACE sends %s',
      async (_label, capabilities) => {
        space.capabilities = capabilities;
        serveContract('3:x');
        space.route('PUT', '/contracts/user-1', { status: 200, body: contract('4:x') });

        const error = await client.contracts
          .updateContractSubscription('user-1', SUBSCRIPTION, {
            keepBillingPeriod: capabilities !== null,
            rejectPrivate: true,
          })
          .catch(e => e);

        expect(error).toBeInstanceOf(SpaceFeatureUnsupportedError);
        expect(error.capability).toBe('reject-private');
        expect(error.written).toBe(false);
        expect(error.message).toContain('rejectPrivate');
        expect(puts()).toHaveLength(0);
      }
    );

    it('Should not send or check rejectPrivate when it is false', async () => {
      space.route('PUT', '/contracts/user-1', { status: 200, body: contract('4:x') });

      await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION, {
        rejectPrivate: false,
      });

      expect(space.requests).toHaveLength(1);
      expect(space.lastRequest().query.has('rejectPrivate')).toBe(false);
    });

    it('Should send rejectPrivate=true on the preview when SPACE advertises reject-private', async () => {
      space.capabilities = WITH_REJECT_PRIVATE;
      space.route('POST', '/contracts/user-1/novation/preview', {
        status: 200,
        body: {
          valid: false,
          errors: [
            {
              code: 'PRIVATE_PLAN',
              service: 'acme',
              path: 'subscriptionPlans.acme',
              message: 'Plan pro is private',
            },
          ],
          contractVersion: '3:x',
        },
      });

      const result = await client.contracts.previewNovation('user-1', SUBSCRIPTION, {
        rejectPrivate: true,
      });

      const req = space.lastRequest();
      expect(req.query.get('rejectPrivate')).toBe('true');
      expect(req.query.has('keepBillingPeriod')).toBe(false);
      expect(result.valid).toBe(false);
      expect(result.errors[0].code).toBe('PRIVATE_PLAN');
    });

    it('Should refuse a rejectPrivate preview from a SPACE without reject-private', async () => {
      space.capabilities = ALL_CAPABILITIES;
      space.route('POST', '/contracts/user-1/novation/preview', {
        status: 200,
        body: { valid: true, errors: [], contractVersion: '3:x' },
      });

      const error = await client.contracts
        .previewNovation('user-1', SUBSCRIPTION, { keepBillingPeriod: true, rejectPrivate: true })
        .catch(e => e);

      expect(error).toBeInstanceOf(SpaceFeatureUnsupportedError);
      expect(error.capability).toBe('reject-private');
      expect(error.written).toBe(false);
    });

    it('Should not send rejectPrivate on the preview when it is not set', async () => {
      space.route('POST', '/contracts/user-1/novation/preview', {
        status: 200,
        body: { valid: true, errors: [], contractVersion: '3:x' },
      });

      await client.contracts.previewNovation('user-1', SUBSCRIPTION, { rejectPrivate: false });

      expect(space.lastRequest().query.has('rejectPrivate')).toBe(false);
    });
  });

  describe('contracts.getContract', () => {
    it('Should fill contractVersion from the ETag header', async () => {
      space.route('GET', '/contracts/user-1', {
        status: 200,
        body: contract(undefined),
        headers: { etag: '"2:etag"' },
      });

      const result = await client.contracts.getContract('user-1');

      expect(result.contractVersion).toBe('2:etag');
      const cache = client.getCache();
      expect((await cache.get<any>(cache.getContractKey('user-1'))).contractVersion).toBe('2:etag');
    });
  });

  describe('URL encoding of userId', () => {
    const USER = 'user/1 ?é';
    const ENCODED = encodeURIComponent(USER);

    it('Should encode the userId in getContract and updateContractSubscription', async () => {
      space.route('GET', `/contracts/${ENCODED}`, { status: 200, body: contract('1:x') });
      space.route('PUT', `/contracts/${ENCODED}`, { status: 200, body: contract('2:x') });

      await client.contracts.getContract(USER);
      await client.contracts.updateContractSubscription(USER, SUBSCRIPTION);

      expect(space.requests.map(r => `${r.method} ${r.path}`)).toEqual([
        `GET /contracts/${ENCODED}`,
        `PUT /contracts/${ENCODED}`,
      ]);
      await client.getCache().invalidateUser(USER);
    });

    it('Should encode the userId in feature evaluations and pricing tokens', async () => {
      space.route('POST', `/features/${ENCODED}/acme-storage`, {
        status: 200,
        body: { eval: true, used: null, limit: null, error: null },
      });
      space.route('POST', `/features/${ENCODED}/pricing-token`, {
        status: 200,
        body: { pricingToken: 'token' },
      });

      await client.features.evaluate(USER, 'acme-storage', { 'acme-storage': 1 });
      await client.features.revertEvaluation(USER, 'acme-storage');
      await client.features.generateUserPricingToken(USER);

      expect(space.requests.map(r => r.path)).toEqual([
        `/features/${ENCODED}/acme-storage`,
        // The revert goes to the feature route (it used to hit `/features/{userId}`, which
        // evaluates every feature and reverts nothing).
        `/features/${ENCODED}/acme-storage`,
        `/features/${ENCODED}/pricing-token`,
      ]);
      await client.getCache().invalidateUser(USER);
    });
  });
});
