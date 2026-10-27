import axios from 'axios';
import { SpaceClient } from '../config/SpaceClient';
import { SpaceFeatureUnsupportedError } from '../errors';
import { EvaluateOptions, FeatureEvaluationResult, WriteOptions } from '../types';
import { ATOMIC_USAGE_LIMITS, checkId, sendKeyedWrite } from '../utils/idempotency';

export class FeatureModule {
  private spaceClient: SpaceClient;

  /**
   * Creates an instance of the `FeatureModule` class.
   *
   * @param spaceClient - An instance of `SpaceClient` used to interact with the Space API.
   */
  constructor(spaceClient: SpaceClient) {
    this.spaceClient = spaceClient;
  }

  /**
   * Evaluates a feature for a specific user by sending a request to the Space API.
   * Results are cached only for read-only evaluations (when expectedConsumption is empty).
   *
   * With an expected consumption the evaluation is a write: SPACE consumes when the feature is
   * enabled and the amounts fit the limits (capability `atomic-usage-limits`), and the result
   * carries the `consumptionId` to revert it with `revertConsumption`. The request carries an
   * `Idempotency-Key` (`options.idempotencyKey`, or a new UUID v4) and is retried with it according
   * to the client's `retries` option, so a retried consumption is applied at most once.
   *
   * @param userId - The ID of the user for whom the feature is being evaluated.
   * @param featureId - The ID of the feature to be evaluated (i.e. \`${serviceName}-${featureName}\`).
   * @param expectedConsumption - An optional record of expected consumption values for the feature.
   * @param options - Optional parameters for the evaluation (`details`, `server`, and, for a
   *   consumption, `idempotencyKey`).
   * @returns A promise that resolves with the response data from the Space API.
   * @throws `IdempotencyConflictError` / `IdempotencyInProgressError` / `IdempotencyKeyInvalidError`
   *   when SPACE refuses the key; `SpaceFeatureUnsupportedError` for an `idempotencyKey` of the
   *   caller on a SPACE without `idempotency-key`.
   * @throws An error if the operation fails.
   */
  public async evaluate(
    userId: string,
    featureId: string,
    expectedConsumption: Record<string, number> = {},
    options: EvaluateOptions = {}
  ): Promise<FeatureEvaluationResult> {

    const cache = this.spaceClient.getCache();
    const isReadOnlyEvaluation = Object.keys(expectedConsumption).length === 0;
    const cacheKey = cache.getFeatureKey(userId, featureId);

    // Only use cache for read-only evaluations (no consumption)
    if (isReadOnlyEvaluation && cache.isEnabled()) {
      const cachedResult = await cache.get<FeatureEvaluationResult>(cacheKey);
      if (cachedResult) {
        return cachedResult;
      }
    }

    const queryParams = [];
    if (options.details) {
      queryParams.push("details=true");
    }
    if (options.server) {
      queryParams.push("server=true");
    }

    const queryString = queryParams.length > 0 ? `?${queryParams.join("&")}` : "";
    const url = `${this.spaceClient.httpUrl}/features/${encodeURIComponent(userId)}/${featureId}${queryString}`;
    const config = {
      headers: {
        'x-api-key': this.spaceClient.apiKey,
      },
      timeout: this.spaceClient.timeout,
    };

    // A read-only evaluation writes nothing: no key (SPACE ignores it there) and no retries.
    const request = isReadOnlyEvaluation
      ? axios.post(url, expectedConsumption, config)
      : sendKeyedWrite<FeatureEvaluationResult>(
          this.spaceClient,
          { ...config, method: 'post', url, data: expectedConsumption },
          options.idempotencyKey
        );

    return await request
      .then(async response => {
        const result = response.data;

        // Cache the result only for read-only evaluations with shorter TTL
        if (isReadOnlyEvaluation && cache.isEnabled()) {
          // Use shorter TTL for feature evaluations (60 seconds)
          await cache.set(cacheKey, result, 60);
        } else if (cache.isEnabled()) {
          // For write operations, invalidate related cache entries
          await cache.delete(cacheKey);
          // Also invalidate contract cache as usage might have changed
          await cache.delete(cache.getContractKey(userId));
          // Invalidate pricing token as user's consumption has changed
          await cache.delete(cache.getPricingTokenKey(userId));
        }

        return result;
      })
      .catch(error => {
        console.error('Error evaluating feature:', error?.response?.data ?? error?.message);
        throw error;
      });
  }

  /**
   * Reverts exactly one consumption, the one an evaluation reported as `consumptionId`
   * (`POST /features/{userId}/{featureId}?revert=true&consumptionId=...`). Its amounts are
   * subtracted once, never below zero, and nothing recorded since is lost. Reverting the same
   * consumption again changes nothing. Use it when the operation the consumption paid for failed
   * in the host application.
   *
   * Needs the `atomic-usage-limits` capability: an older SPACE ignores `consumptionId` and restores
   * a cached snapshot of the level instead, so the client refuses with
   * `SpaceFeatureUnsupportedError` (nothing written) when SPACE does not advertise it. The request
   * carries an `Idempotency-Key` and is retried like the other keyed writes.
   *
   * @param userId - The ID of the user whose consumption is reverted.
   * @param featureId - The feature the consumption was made for (\`${serviceName}-${featureName}\`).
   * @param consumptionId - The `consumptionId` of the evaluation that consumed.
   * @param options - `idempotencyKey` of this revert (optional).
   * @returns `true` when the consumption is reverted (now or by an earlier call); `false` when SPACE
   *   does not know it (404: unknown or expired id, another user or feature, or no contract), in
   *   which case nothing changed.
   * @throws `SpaceFeatureUnsupportedError` if SPACE does not advertise `atomic-usage-limits`.
   * @throws An error if the operation fails.
   */
  public async revertConsumption(
    userId: string,
    featureId: string,
    consumptionId: string,
    options: WriteOptions = {}
  ): Promise<boolean> {
    checkId(consumptionId, 'consumptionId');
    if (!(await this.spaceClient.hasCapability(ATOMIC_USAGE_LIMITS))) {
      throw new SpaceFeatureUnsupportedError(
        ATOMIC_USAGE_LIMITS,
        'The connected SPACE does not support revert by consumptionId: nothing was written'
      );
    }

    return await sendKeyedWrite(
      this.spaceClient,
      {
        method: 'post',
        url: `${this.spaceClient.httpUrl}/features/${encodeURIComponent(userId)}/${featureId}`,
        params: { revert: 'true', consumptionId },
        data: {},
        headers: {
          'x-api-key': this.spaceClient.apiKey,
        },
        timeout: this.spaceClient.timeout,
      },
      options.idempotencyKey
    )
      .then(async () => {
        await this.invalidateUsage(userId, featureId);
        return true;
      })
      .catch(error => {
        if (error?.response?.status === 404) {
          return false;
        }
        console.error(
          `Error reverting consumption ${consumptionId} of feature ${featureId} for user ${userId}:`,
          error?.response?.data ?? error?.message
        );
        throw error;
      });
  }

  /**
   * Reverts the optimistic usage level update performed during a previous evaluation with SPACE.
   * This method is expected to be used when the transaction of the request has failed in the application, and therefore no usage should be charged to the user.
   * This method also invalidates cached data for the user.
   *
   * @deprecated Use `revertConsumption(userId, featureId, consumptionId)` with the `consumptionId`
   *   of the evaluation: this method reverts whichever consumption of the feature SPACE finds in the
   *   last two minutes (the oldest, or the newest with `revertToLatest`), which may not be the one
   *   the caller means.
   * @param userId - The ID of the user for whom the feature is being evaluated.
   * @param featureId - The ID of the feature to be evaluated (i.e. \`${serviceName}-${featureName}\`).
   * @param revertToLatest - A boolean indicating whether to reset to the latest stored value in the optimistic cache (`true => newest` | `false => oldest`).
   * @param options - `idempotencyKey` of this revert (optional).
   * @returns A promise that resolves to `true` if the revert operation was successful, otherwise it throws an error.
   * @throws An error if the operation fails.
   */
  public async revertEvaluation(
    userId: string,
    featureId: string,
    revertToLatest: boolean = true,
    options: WriteOptions = {}
  ): Promise<boolean> {
    return await sendKeyedWrite(
      this.spaceClient,
      {
        method: 'post',
        url: `${this.spaceClient.httpUrl}/features/${encodeURIComponent(userId)}/${featureId}`,
        params: { revert: 'true', latest: String(revertToLatest) },
        data: {},
        headers: {
          'x-api-key': this.spaceClient.apiKey,
        },
        timeout: this.spaceClient.timeout,
      },
      options.idempotencyKey
    )
      .then(async () => {
        // Invalidate related cache entries after reverting
        await this.invalidateUsage(userId, featureId);
        return true;
      })
      .catch(error => {
        console.error(
          `Error reverting usage level for evaluation of feature ${featureId} for user ${userId}:`,
          error?.response?.data ?? error?.message
        );
        throw error;
      });
  }

  /** Drops what the cache holds about a user's usage after a revert. */
  private async invalidateUsage(userId: string, featureId: string): Promise<void> {
    const cache = this.spaceClient.getCache();
    if (cache.isEnabled()) {
      await cache.delete(cache.getFeatureKey(userId, featureId));
      await cache.delete(cache.getContractKey(userId));
      // Invalidate pricing token as user's consumption has changed
      await cache.delete(cache.getPricingTokenKey(userId));
    }
  }

  /**
   * Generates a pricing token for a user by sending a request to the Space API.
   * This token can be used to retrieve pricing information for the user or to 
   * activate/deactivate UI components without providing access to the SPACE API from 
   * the internet. The token is cached to improve performance.
   * 
   * @param userId - The ID of the user for whom the pricing token is being generated.
   * @returns A promise that resolves with the generated pricing token.
   * @throws An error if the operation fails.
   */
  public async generateUserPricingToken(userId: string): Promise<string> {
    const cache = this.spaceClient.getCache();
    const cacheKey = cache.getPricingTokenKey(userId);

    // Try to get from cache first
    if (cache.isEnabled()) {
      const cachedToken = await cache.get<string>(cacheKey);
      if (cachedToken) {
        return cachedToken;
      }
    }

    return await axios
      .post(`${this.spaceClient.httpUrl}/features/${encodeURIComponent(userId)}/pricing-token`, {}, {
        headers: {
          'x-api-key': this.spaceClient.apiKey,
        },
        timeout: this.spaceClient.timeout,
      })
      .then(async response => {
        const token = response.data.pricingToken;
        
        // Cache the token if caching is enabled (with longer TTL as tokens are more stable)
        if (cache.isEnabled()) {
          // Use longer TTL for pricing tokens (15 minutes)
          await cache.set(cacheKey, token, 900);
        }
        
        return token;
      })
      .catch(error => {
        try{
          console.error('Error generating user pricing token:', error.response.error);
        }finally {
          throw error;
        }
      });
  }
}
