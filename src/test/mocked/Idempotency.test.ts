import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyKeyInvalidError,
  SpaceClient,
  SpaceConnectionOptions,
  SpaceFeatureUnsupportedError,
} from '../../main/index';
import { MockResponse, MockSpace, RecordedRequest } from './mockSpace';

const API_KEY = 'test-org-key';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPABILITIES = ['atomic-usage-limits', 'idempotency-key', 'contract-version'];

const EVALUATION = {
  eval: true,
  used: { 'acme-maxPets': 2 },
  limit: { 'acme-maxPets': 4 },
  error: null,
  consumptionId: '6f1c2a5e-6a7b-4c4d-9e8f-0a1b2c3d4e5f',
};

const CONTRACT = {
  userContact: { userId: 'user-1', username: 'user1' },
  billingPeriod: {
    startDate: '2026-10-01T00:00:00.000Z',
    endDate: '2026-10-31T00:00:00.000Z',
    autoRenew: true,
    renewalDays: 30,
  },
  usageLevels: {},
  contractedServices: { acme: '2025-01-10' },
  subscriptionPlans: { acme: 'pro' },
  subscriptionAddOns: {},
  history: [],
};

const CONTRACT_TO_CREATE = {
  userContact: { userId: 'user-1', username: 'user1' },
  contractedServices: { acme: '2025-01-10' },
  subscriptionPlans: { acme: 'pro' },
  subscriptionAddOns: {},
};

const SUBSCRIPTION = {
  contractedServices: { acme: '2025-01-10' },
  subscriptionPlans: { acme: 'basic' },
  subscriptionAddOns: {},
};

const IN_PROGRESS: MockResponse = {
  status: 409,
  body: { error: 'A request with this Idempotency-Key is still being processed', code: 'IDEMPOTENCY_IN_PROGRESS' },
  headers: { 'retry-after': '1' },
};

/** Answers the given responses in order, then repeats the last one. */
function sequence(...responses: MockResponse[]): (req: RecordedRequest) => MockResponse {
  let next = 0;
  return () => responses[Math.min(next++, responses.length - 1)];
}

describe('Idempotency-Key, retries and consumption ids against a mocked SPACE', () => {
  const space = new MockSpace();
  const clients: SpaceClient[] = [];
  let sleeps: number[];

  beforeAll(async () => {
    await space.start();
  });

  afterEach(async () => {
    space.reset();
    vi.restoreAllMocks();
    while (clients.length > 0) {
      await clients.pop()!.close();
    }
  });

  afterAll(async () => {
    await space.stop();
  });

  /** A client whose waits between retries are recorded instead of slept. */
  function newClient(options: Partial<SpaceConnectionOptions> = {}): SpaceClient {
    const client = new SpaceClient({ url: space.url, apiKey: API_KEY, ...options });
    clients.push(client);
    sleeps = [];
    if ('sleep' in client) {
      vi.spyOn(client, 'sleep').mockImplementation(async (ms: number) => {
        sleeps.push(ms);
      });
    }
    return client;
  }

  function requestsTo(method: string, path: string): RecordedRequest[] {
    return space.requests.filter(r => r.method === method && r.path === path);
  }

  function keysOf(requests: RecordedRequest[]): (string | undefined)[] {
    return requests.map(r => r.headers['idempotency-key'] as string | undefined);
  }

  describe('features.evaluate with an expected consumption', () => {
    it('Should send a UUID v4 Idempotency-Key and return the consumptionId', async () => {
      space.capabilities = CAPABILITIES;
      space.route('POST', '/features/user-1/acme-pets', { status: 200, body: EVALUATION });
      const client = newClient();

      const result = await client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 });

      expect(result.consumptionId).toBe(EVALUATION.consumptionId);
      const [key] = keysOf(requestsTo('POST', '/features/user-1/acme-pets'));
      expect(key).toMatch(UUID_V4);
    });

    it('Should use a new key for every call', async () => {
      space.capabilities = CAPABILITIES;
      space.route('POST', '/features/user-1/acme-pets', { status: 200, body: EVALUATION });
      const client = newClient();

      await client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 });
      await client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 });

      const [first, second] = keysOf(requestsTo('POST', '/features/user-1/acme-pets'));
      expect(first).not.toBe(second);
    });

    it('Should not send a key on an evaluation that does not consume', async () => {
      space.route('POST', '/features/user-1/acme-pets', {
        status: 200,
        body: { eval: true, used: null, limit: null, error: null },
      });
      const client = newClient();

      await client.features.evaluate('user-1', 'acme-pets');

      expect(keysOf(requestsTo('POST', '/features/user-1/acme-pets'))).toEqual([undefined]);
    });

    it('Should send the caller-supplied key verbatim', async () => {
      space.capabilities = CAPABILITIES;
      space.route('POST', '/features/user-1/acme-pets', { status: 200, body: EVALUATION });
      const client = newClient();

      await client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 }, {
        idempotencyKey: 'order-42:pets',
      });

      expect(keysOf(requestsTo('POST', '/features/user-1/acme-pets'))).toEqual(['order-42:pets']);
    });

    it('Should reject an empty or too long key before sending anything', async () => {
      space.capabilities = CAPABILITIES;
      const client = newClient();

      await expect(
        client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 }, { idempotencyKey: '' })
      ).rejects.toThrow(TypeError);
      await expect(
        client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 }, {
          idempotencyKey: 'k'.repeat(256),
        })
      ).rejects.toThrow(TypeError);
      expect(space.requests).toHaveLength(0);
    });

    it('Should refuse a caller-supplied key when SPACE does not support Idempotency-Key', async () => {
      space.capabilities = ['atomic-usage-limits'];
      space.route('GET', '/healthcheck', { status: 200, body: { message: 'ok' } });
      space.route('POST', '/features/user-1/acme-pets', { status: 200, body: EVALUATION });
      const client = newClient();

      const error = await client.features
        .evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 }, { idempotencyKey: 'order-42' })
        .catch(e => e);

      expect(error).toBeInstanceOf(SpaceFeatureUnsupportedError);
      expect(error.capability).toBe('idempotency-key');
      expect(error.written).toBe(false);
      expect(requestsTo('POST', '/features/user-1/acme-pets')).toHaveLength(0);
    });
  });

  describe('retries', () => {
    it('Should not retry by default', async () => {
      space.capabilities = CAPABILITIES;
      space.route('POST', '/features/user-1/acme-pets', { status: 503, body: { error: 'down' } });
      const client = newClient();

      await expect(
        client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 })
      ).rejects.toMatchObject({ response: { status: 503 } });
      expect(requestsTo('POST', '/features/user-1/acme-pets')).toHaveLength(1);
    });

    it('Should retry a 5xx with the same key', async () => {
      space.capabilities = CAPABILITIES;
      space.route(
        'POST',
        '/features/user-1/acme-pets',
        sequence({ status: 502, body: { error: 'bad gateway' } }, { status: 200, body: EVALUATION })
      );
      const client = newClient({ retries: 2 });

      const result = await client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 });

      expect(result.consumptionId).toBe(EVALUATION.consumptionId);
      const keys = keysOf(requestsTo('POST', '/features/user-1/acme-pets'));
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(UUID_V4);
      expect(keys[1]).toBe(keys[0]);
    });

    it('Should retry a dropped connection with the same key and the same body', async () => {
      space.capabilities = CAPABILITIES;
      space.route(
        'POST',
        '/features/user-1/acme-pets',
        sequence({ status: 0, destroy: true }, { status: 200, body: EVALUATION })
      );
      const client = newClient({ retries: 1 });
      // The capabilities are known from an earlier answer.
      space.route('GET', '/healthcheck', { status: 200, body: { message: 'ok' } });
      await client.hasCapability('idempotency-key');

      await client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 }, {
        idempotencyKey: 'order-7',
      });

      const requests = requestsTo('POST', '/features/user-1/acme-pets');
      expect(keysOf(requests)).toEqual(['order-7', 'order-7']);
      expect(requests[1].body).toEqual(requests[0].body);
    });

    it('Should learn the capabilities from /healthcheck before retrying a dropped connection', async () => {
      space.capabilities = CAPABILITIES;
      space.route('GET', '/healthcheck', { status: 200, body: { message: 'ok' } });
      space.route(
        'POST',
        '/features/user-1/acme-pets',
        sequence({ status: 0, destroy: true }, { status: 200, body: EVALUATION })
      );
      const client = newClient({ retries: 1 });

      await client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 });

      expect(requestsTo('GET', '/healthcheck')).toHaveLength(1);
      expect(requestsTo('POST', '/features/user-1/acme-pets')).toHaveLength(2);
    });

    it('Should not retry against a SPACE that does not advertise idempotency-key', async () => {
      // An older SPACE ignores the header: a retry could consume twice.
      space.capabilities = ['contract-version'];
      space.route('POST', '/features/user-1/acme-pets', { status: 503, body: { error: 'down' } });
      const client = newClient({ retries: 3 });

      await expect(
        client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 })
      ).rejects.toMatchObject({ response: { status: 503 } });
      expect(requestsTo('POST', '/features/user-1/acme-pets')).toHaveLength(1);
    });

    it('Should honour Retry-After on 409 IDEMPOTENCY_IN_PROGRESS and keep the key', async () => {
      space.capabilities = CAPABILITIES;
      space.route(
        'POST',
        '/features/user-1/acme-pets',
        sequence(IN_PROGRESS, {
          status: 200,
          body: EVALUATION,
          headers: { 'idempotent-replayed': 'true' },
        })
      );
      const client = newClient({ retries: 2, retryBaseDelayMs: 10 });

      const result = await client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 });

      expect(result.consumptionId).toBe(EVALUATION.consumptionId);
      expect(sleeps).toEqual([1000]);
      const keys = keysOf(requestsTo('POST', '/features/user-1/acme-pets'));
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    });

    it('Should throw IdempotencyInProgressError once the retries are spent', async () => {
      space.capabilities = CAPABILITIES;
      space.route('POST', '/features/user-1/acme-pets', IN_PROGRESS);
      const client = newClient({ retries: 2 });

      const error = await client.features
        .evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 }, { idempotencyKey: 'order-9' })
        .catch(e => e);

      expect(error).toBeInstanceOf(IdempotencyInProgressError);
      expect(error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(error.status).toBe(409);
      expect(error.retryAfter).toBe(1);
      expect(error.idempotencyKey).toBe('order-9');
      expect(requestsTo('POST', '/features/user-1/acme-pets')).toHaveLength(3);
      expect(sleeps).toEqual([1000, 1000]);
    });

    it('Should not wait longer than retryMaxDelayMs: a longer Retry-After ends the retries', async () => {
      space.capabilities = CAPABILITIES;
      space.route('POST', '/features/user-1/acme-pets', {
        ...IN_PROGRESS,
        headers: { 'retry-after': '120' },
      });
      const client = newClient({ retries: 2, retryMaxDelayMs: 5000 });

      const error = await client.features
        .evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 })
        .catch(e => e);

      expect(error).toBeInstanceOf(IdempotencyInProgressError);
      expect(error.retryAfter).toBe(120);
      expect(requestsTo('POST', '/features/user-1/acme-pets')).toHaveLength(1);
      expect(sleeps).toEqual([]);
    });

    it('Should back off exponentially, bounded by retryMaxDelayMs', async () => {
      space.capabilities = CAPABILITIES;
      space.route('POST', '/features/user-1/acme-pets', { status: 500, body: { error: 'boom' } });
      vi.spyOn(Math, 'random').mockReturnValue(0.999999);
      const client = newClient({ retries: 4, retryBaseDelayMs: 100, retryMaxDelayMs: 300 });

      await expect(
        client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 })
      ).rejects.toMatchObject({ response: { status: 500 } });

      expect(requestsTo('POST', '/features/user-1/acme-pets')).toHaveLength(5);
      expect(sleeps.map(Math.round)).toEqual([100, 200, 300, 300]);
    });

    it('Should throw IdempotencyConflictError on 409 IDEMPOTENCY_CONFLICT without retrying', async () => {
      space.capabilities = CAPABILITIES;
      space.route('POST', '/features/user-1/acme-pets', {
        status: 409,
        body: { error: 'Idempotency-Key reused', code: 'IDEMPOTENCY_CONFLICT' },
      });
      const client = newClient({ retries: 3 });

      const error = await client.features
        .evaluate('user-1', 'acme-pets', { 'acme-maxPets': 2 }, { idempotencyKey: 'order-1' })
        .catch(e => e);

      expect(error).toBeInstanceOf(IdempotencyConflictError);
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(error.idempotencyKey).toBe('order-1');
      expect(error.cause?.response?.status).toBe(409);
      expect(requestsTo('POST', '/features/user-1/acme-pets')).toHaveLength(1);
    });

    it('Should throw IdempotencyKeyInvalidError on 400 IDEMPOTENCY_KEY_INVALID', async () => {
      space.capabilities = CAPABILITIES;
      space.route('POST', '/features/user-1/acme-pets', {
        status: 400,
        body: { error: 'Idempotency-Key must have between 1 and 255 characters', code: 'IDEMPOTENCY_KEY_INVALID' },
      });
      const client = newClient({ retries: 3 });

      const error = await client.features
        .evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 })
        .catch(e => e);

      expect(error).toBeInstanceOf(IdempotencyKeyInvalidError);
      expect(error.status).toBe(400);
      expect(requestsTo('POST', '/features/user-1/acme-pets')).toHaveLength(1);
    });

    it('Should never retry any other 4xx', async () => {
      space.capabilities = CAPABILITIES;
      space.route('POST', '/features/user-1/acme-pets', {
        status: 409,
        body: { error: 'The contract kept changing' },
      });
      space.route('POST', '/contracts', { status: 400, body: { error: 'Invalid plan' } });
      const client = newClient({ retries: 3 });

      await expect(
        client.features.evaluate('user-1', 'acme-pets', { 'acme-maxPets': 1 })
      ).rejects.toMatchObject({ response: { status: 409 } });
      await expect(client.contracts.addContract(CONTRACT_TO_CREATE)).rejects.toMatchObject({
        response: { status: 400 },
      });
      expect(requestsTo('POST', '/features/user-1/acme-pets')).toHaveLength(1);
      expect(requestsTo('POST', '/contracts')).toHaveLength(1);
    });

    it('Should not retry writes that carry no key', async () => {
      space.capabilities = CAPABILITIES;
      space.route('GET', '/contracts/user-1/pricings', { status: 503, body: { error: 'down' } });
      const client = newClient({ retries: 3 });

      await expect(client.contracts.getPricings('user-1')).rejects.toMatchObject({
        response: { status: 503 },
      });
      expect(requestsTo('GET', '/contracts/user-1/pricings')).toHaveLength(1);
    });

    it('Should reject an invalid retries option', () => {
      expect(() => new SpaceClient({ url: space.url, apiKey: API_KEY, retries: -1 })).toThrow(RangeError);
      expect(() => new SpaceClient({ url: space.url, apiKey: API_KEY, retries: 11 })).toThrow(RangeError);
    });
  });

  describe('features.revertConsumption', () => {
    it('Should revert by consumptionId with a key and answer true on 204', async () => {
      space.capabilities = CAPABILITIES;
      space.route('POST', '/features/user-1/acme-pets', { status: 204 });
      const client = newClient();

      const reverted = await client.features.revertConsumption('user-1', 'acme-pets', EVALUATION.consumptionId);

      expect(reverted).toBe(true);
      const req = space.lastRequest();
      expect(req.query.get('revert')).toBe('true');
      expect(req.query.get('consumptionId')).toBe(EVALUATION.consumptionId);
      expect(req.query.has('latest')).toBe(false);
      expect(req.headers['idempotency-key']).toMatch(UUID_V4);
    });

    it('Should answer false when SPACE does not know the consumption (404)', async () => {
      space.capabilities = CAPABILITIES;
      space.route('POST', '/features/user-1/acme-pets', {
        status: 404,
        body: { error: 'Consumption not found' },
      });
      const client = newClient();

      await expect(
        client.features.revertConsumption('user-1', 'acme-pets', 'unknown-id')
      ).resolves.toBe(false);
    });

    it('Should retry with the same key', async () => {
      space.capabilities = CAPABILITIES;
      space.route(
        'POST',
        '/features/user-1/acme-pets',
        sequence({ status: 503, body: { error: 'down' } }, { status: 204 })
      );
      const client = newClient({ retries: 1 });

      await expect(
        client.features.revertConsumption('user-1', 'acme-pets', 'c-1', { idempotencyKey: 'undo-c-1' })
      ).resolves.toBe(true);
      expect(keysOf(requestsTo('POST', '/features/user-1/acme-pets'))).toEqual(['undo-c-1', 'undo-c-1']);
    });

    it('Should refuse without writing when SPACE does not advertise atomic-usage-limits', async () => {
      // An older SPACE ignores consumptionId and reverts a snapshot of the level instead.
      space.capabilities = ['idempotency-key'];
      space.route('GET', '/healthcheck', { status: 200, body: { message: 'ok' } });
      space.route('POST', '/features/user-1/acme-pets', { status: 204 });
      const client = newClient();

      const error = await client.features.revertConsumption('user-1', 'acme-pets', 'c-1').catch(e => e);

      expect(error).toBeInstanceOf(SpaceFeatureUnsupportedError);
      expect(error.capability).toBe('atomic-usage-limits');
      expect(requestsTo('POST', '/features/user-1/acme-pets')).toHaveLength(0);
    });

    it('Should reject an empty consumptionId', async () => {
      const client = newClient();
      await expect(client.features.revertConsumption('user-1', 'acme-pets', '')).rejects.toThrow(TypeError);
      expect(space.requests).toHaveLength(0);
    });
  });

  describe('features.revertEvaluation (deprecated)', () => {
    it('Should revert on the feature route with a key', async () => {
      space.route('POST', '/features/user-1/acme-pets', { status: 204 });
      const client = newClient();

      await expect(client.features.revertEvaluation('user-1', 'acme-pets', false)).resolves.toBe(true);

      const req = space.lastRequest();
      expect(req.path).toBe('/features/user-1/acme-pets');
      expect(req.query.get('revert')).toBe('true');
      expect(req.query.get('latest')).toBe('false');
      expect(req.headers['idempotency-key']).toMatch(UUID_V4);
    });
  });

  describe('contracts', () => {
    it('Should send a key with addContract and reuse it on a retry', async () => {
      space.capabilities = CAPABILITIES;
      space.route(
        'POST',
        '/contracts',
        sequence({ status: 504, body: { error: 'timeout' } }, { status: 201, body: CONTRACT })
      );
      const client = newClient({ retries: 1 });

      await client.contracts.addContract(CONTRACT_TO_CREATE);

      const keys = keysOf(requestsTo('POST', '/contracts'));
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(UUID_V4);
      expect(keys[1]).toBe(keys[0]);
    });

    it('Should send the caller key with addContract', async () => {
      space.capabilities = CAPABILITIES;
      space.route('POST', '/contracts', {
        status: 201,
        body: CONTRACT,
        headers: { 'idempotent-replayed': 'true' },
      });
      const client = newClient();

      const contract = await client.contracts.addContract(CONTRACT_TO_CREATE, { idempotencyKey: 'signup-user-1' });

      expect(contract.userContact.userId).toBe('user-1');
      expect(keysOf(requestsTo('POST', '/contracts'))).toEqual(['signup-user-1']);
    });

    it('Should send a key with a novation and reuse it on a retry', async () => {
      space.capabilities = CAPABILITIES;
      space.route(
        'PUT',
        '/contracts/user-1',
        sequence(IN_PROGRESS, { status: 200, body: CONTRACT, headers: { etag: '"2"' } })
      );
      const client = newClient({ retries: 1 });

      await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION, {
        idempotencyKey: 'change-plan-user-1',
      });

      expect(keysOf(requestsTo('PUT', '/contracts/user-1'))).toEqual([
        'change-plan-user-1',
        'change-plan-user-1',
      ]);
      expect(sleeps).toEqual([1000]);
    });

    it('Should keep If-Match on every attempt of a guarded novation', async () => {
      space.capabilities = CAPABILITIES;
      space.route(
        'PUT',
        '/contracts/user-1',
        sequence({ status: 503, body: { error: 'down' } }, { status: 200, body: CONTRACT, headers: { etag: '"2"' } })
      );
      const client = newClient({ retries: 1 });
      await client.hasCapability('contract-version');

      await client.contracts.updateContractSubscription('user-1', SUBSCRIPTION, {
        expectedContractVersion: '1',
      });

      const puts = requestsTo('PUT', '/contracts/user-1');
      expect(puts.map(r => r.headers['if-match'])).toEqual(['"1"', '"1"']);
      expect(puts[1].headers['idempotency-key']).toBe(puts[0].headers['idempotency-key']);
    });
  });

  describe('hasCapability', () => {
    it('Should read the capabilities from /healthcheck once and then use the cached ones', async () => {
      space.capabilities = CAPABILITIES;
      space.route('GET', '/healthcheck', { status: 200, body: { message: 'ok' } });
      const client = newClient();

      await expect(client.hasCapability('idempotency-key')).resolves.toBe(true);
      await expect(client.hasCapability('atomic-usage-limits')).resolves.toBe(true);
      await expect(client.hasCapability('something-else')).resolves.toBe(false);

      expect(requestsTo('GET', '/healthcheck')).toHaveLength(1);
    });
  });
});
