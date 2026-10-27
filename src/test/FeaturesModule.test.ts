import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SpaceClient, pricingTokenUserId } from '../main/index';
import { setUpTestEnvironment } from './utils/setup';
import { v4 as uuidv4 } from 'uuid';
import { Contract } from '../main/types';
import { TEST_API_KEY, TEST_SPACE_URL } from './lib/axios';

describe('Features Module Test Suite', () => {
  let client: SpaceClient;
  let testContract: Contract;

  beforeAll(async () => {
    client = await setUpTestEnvironment();
    testContract = await client.contracts.addContract({
      userContact: {
        userId: uuidv4(),
        username: `testUser-${uuidv4()}`,
      },
      billingPeriod: {
        autoRenew: true,
        renewalDays: 30,
      },
      contractedServices: {
        tomatoMeter: '1.0.0',
      },
      subscriptionPlans: {
        tomatoMeter: 'ADVANCED',
      },
      subscriptionAddOns: {
        tomatoMeter: {
          'extraTimers': 2,
        },
      },
    })
  });

  afterAll(async () => {
    if (client && await client.isConnectedToSpace()) {
      client.disconnect();
    }
  })

  it('Should evaluate feature with usage limit', async () => {
    const testFeatureId = "tomatometer-pomodoroTimer"

    const response = await client.features.evaluate(testContract.userContact.userId, testFeatureId);

    expect(response).toBeDefined();
    expect(response.eval).toBeTruthy();
  });

  it('Should evaluate feature with defaultValue = true', async () => {
    const testFeatureId = "tomatometer-soundNotifications"

    const response = await client.features.evaluate(testContract.userContact.userId, testFeatureId);

    expect(response).toBeDefined();
    expect(response.eval).toBeTruthy();
  });

  it('Should evaluate feature with defaultValue = false, but value = true', async () => {
    const testFeatureId = "tomatometer-dailySummary"

    const response = await client.features.evaluate(testContract.userContact.userId, testFeatureId);

    expect(response).toBeDefined();
    expect(response.eval).toBeTruthy();
  });

  it('Should evaluate feature and update usage level', async () => {
    const testFeatureId = "tomatometer-pomodoroTimer"
    const expectedConsumption = { 'tomatometer-maxPomodoroTimers': 1 };

    const response = await client.features.evaluate(testContract.userContact.userId, testFeatureId, expectedConsumption);

    expect(response).toBeDefined();
    expect(response.eval).toBeTruthy();
    expect(response.used).toBeDefined();
    expect(response.used!['tomatometer-maxPomodoroTimers']).toBe(1);
  });

  it('Should create pricingToken', async () => {
    const token = await client.features.generateUserPricingToken(testContract.userContact.userId);

    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    const parts = token.split('.');
    expect(parts.length).toBe(3);

    const header = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf-8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));

    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(header.alg).toBe('HS256'); // or the expected algorithm
    // `sub` is opaque (`urn:space:<organizationId>:<userId>` since space#80): read the userId claim.
    expect(payload.userId).toBe(testContract.userContact.userId);
    expect(pricingTokenUserId(payload)).toBe(testContract.userContact.userId);
  });

  it('Should cache pricing tokens and reuse them', async () => {
    // Create a new client with cache enabled to test caching behavior
    const cacheClient = new SpaceClient({
      url: TEST_SPACE_URL,
      apiKey: TEST_API_KEY,
      cache: { enabled: true }
    });

    await cacheClient.connect();

    // First call should hit the API and cache the result
    const token1 = await cacheClient.features.generateUserPricingToken(testContract.userContact.userId);
    expect(token1).toBeDefined();
    expect(typeof token1).toBe('string');

    // Second call should return the cached token (same token)
    const token2 = await cacheClient.features.generateUserPricingToken(testContract.userContact.userId);
    expect(token2).toBe(token1);

    // Verify the token is actually cached
    const cachedToken = await cacheClient.getCache().get(
      cacheClient.getCache().getPricingTokenKey(testContract.userContact.userId)
    );
    expect(cachedToken).toBe(token1);

    await cacheClient.disconnect();
  });

  it('Should invalidate pricing tokens after evaluation with consumption', async () => {
    // Create a new client with cache enabled
    const cacheClient = new SpaceClient({
      url: TEST_SPACE_URL,
      apiKey: TEST_API_KEY,
      cache: { enabled: true }
    });

    await cacheClient.connect();

    // Cache a pricing token
    const initialToken = await cacheClient.features.generateUserPricingToken(testContract.userContact.userId);
    expect(initialToken).toBeDefined();

    // Verify it's cached
    let cachedToken = await cacheClient.getCache().get(
      cacheClient.getCache().getPricingTokenKey(testContract.userContact.userId)
    );
    expect(cachedToken).toBe(initialToken);

    // Evaluate a feature with consumption (should invalidate pricing token cache)
    const testFeatureId = "tomatometer-pomodoroTimer";
    const expectedConsumption = { 'tomatometer-maxPomodoroTimers': 1 };
    
    await cacheClient.features.evaluate(testContract.userContact.userId, testFeatureId, expectedConsumption);

    // Verify pricing token cache was invalidated
    cachedToken = await cacheClient.getCache().get(
      cacheClient.getCache().getPricingTokenKey(testContract.userContact.userId)
    );
    expect(cachedToken).toBeNull();

    await cacheClient.disconnect();
  });

  it('Should invalidate pricing tokens after revert evaluation', async () => {
    // Create a new client with cache enabled
    const cacheClient = new SpaceClient({
      url: TEST_SPACE_URL,
      apiKey: TEST_API_KEY,
      cache: { enabled: true }
    });

    await cacheClient.connect();

    // Cache a pricing token
    const initialToken = await cacheClient.features.generateUserPricingToken(testContract.userContact.userId);
    expect(initialToken).toBeDefined();

    // Revert an evaluation (should invalidate pricing token cache)
    const testFeatureId = "tomatometer-pomodoroTimer";
    const revertResult = await cacheClient.features.revertEvaluation(testContract.userContact.userId, testFeatureId);
    expect(revertResult).toBe(true);

    // Verify pricing token cache was invalidated
    const cachedToken = await cacheClient.getCache().get(
      cacheClient.getCache().getPricingTokenKey(testContract.userContact.userId)
    );
    expect(cachedToken).toBeNull();

    await cacheClient.disconnect();
  });
});
