import axios from 'axios';
import { SpaceClient } from '../config/SpaceClient';
import {FeatureEvaluationResult } from '../types';

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
   * @param userId - The ID of the user for whom the feature is being evaluated.
   * @param featureId - The ID of the feature to be evaluated (i.e. \`${serviceName}-${featureName}\`).
   * @param expectedConsumption - An optional record of expected consumption values for the feature.
   * @param options - Optional parameters for the evaluation.
   * @returns A promise that resolves with the response data from the Space API.
   * @throws An error if the operation fails.
   */
  public async evaluate(
    userId: string,
    featureId: string,
    expectedConsumption: Record<string, number> = {},
    options: {details?: boolean, server?: boolean} = {}
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

    return await axios
      .post(`${this.spaceClient.httpUrl}/features/${encodeURIComponent(userId)}/${featureId}${queryString}`, expectedConsumption, {
        headers: {
          'x-api-key': this.spaceClient.apiKey,
        },
        timeout: this.spaceClient.timeout,
      })
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
        console.error('Error evaluating feature:', error.response.data);
        throw error;
      });
  }

  /**
   * Reverts the optimistic usage level update performed during a previous evaluation with SPACE.
   * This method is expected to be used when the transaction of the request has failed in the application, and therefore no usage should be charged to the user.
   * This method also invalidates cached data for the user.
   * 
   * @param userId - The ID of the user for whom the feature is being evaluated.
   * @param featureId - The ID of the feature to be evaluated (i.e. \`${serviceName}-${featureName}\`).
   * @param revertToLatest - A boolean indicating whether to reset to the latest stored value in the optimistic cache (`true => newest` | `false => oldest`).
   * @returns A promise that resolves to `true` if the revert operation was successful, otherwise it throws an error.
   * @throws An error if the operation fails.
   */
  public async revertEvaluation(userId: string, featureId: string, revertToLatest: boolean = true): Promise<boolean> {
    return await axios
      .post(`${this.spaceClient.httpUrl}/features/${encodeURIComponent(userId)}?revert=true&latest=${revertToLatest}`, {}, {
        headers: {
          'x-api-key': this.spaceClient.apiKey,
        },
        timeout: this.spaceClient.timeout,
      })
      .then(async () => {
        const cache = this.spaceClient.getCache();
        
        // Invalidate related cache entries after reverting
        if (cache.isEnabled()) {
          await cache.delete(cache.getFeatureKey(userId, featureId));
          await cache.delete(cache.getContractKey(userId));
          // Invalidate pricing token as user's consumption has changed
          await cache.delete(cache.getPricingTokenKey(userId));
        }
        
        return true;
      })
      .catch(error => {
        console.error(`Error reverting usage level for evaluation of feature ${featureId} for user ${userId}:`, error.response.data);
        throw error;
      });
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
