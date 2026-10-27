import { SpaceClient } from '../config/SpaceClient';
import { CacheProvider, CacheOptions } from '../types/cache';
import { CacheProviderFactory } from './cache/CacheProviderFactory';

/**
 * Internal cache module for SpaceClient
 * This module provides caching functionality that can only be accessed
 * by SpaceClient and its internal modules
 */
export class CacheModule {
  private spaceClient: SpaceClient;
  private provider: CacheProvider | null = null;
  private enabled: boolean = false;
  private readonly keyPrefix: string = 'space-client:';

  /**
   * Creates an instance of the CacheModule class.
   * This constructor is internal and should only be called by SpaceClient
   *
   * @param spaceClient - An instance of SpaceClient used to interact with the Space API.
   */
  constructor(spaceClient: SpaceClient) {
    this.spaceClient = spaceClient;
  }

  /**
   * Initialize the cache with the provided options
   * This method is internal and should only be called by SpaceClient
   */
  async initialize(options: CacheOptions): Promise<void> {
    if (!options.enabled) {
      this.enabled = false;
      return;
    }

    try {
      CacheProviderFactory.validate(options);
      this.provider = CacheProviderFactory.create(options);
      this.enabled = true;
    } catch (error) {
      console.error('[CacheModule] Failed to initialize cache:', error);
      throw new Error(`Cache initialization failed: ${error}`);
    }
  }

  /**
   * Check if caching is enabled and available
   */
  isEnabled(): boolean {
    return this.enabled && this.provider !== null;
  }

  /**
   * Get a value from the cache
   */
  async get<T = any>(key: string): Promise<T | null> {
    if (!this.isEnabled()) {
      return null;
    }

    try {
      return await this.provider!.get<T>(this.getFullKey(key));
    } catch (error) {
      console.error('[CacheModule] Error getting cached value:', error);
      return null;
    }
  }

  /**
   * Set a value in the cache
   */
  async set<T = any>(key: string, value: T, ttl?: number): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    try {
      await this.provider!.set(this.getFullKey(key), value, ttl);
    } catch (error) {
      console.error('[CacheModule] Error setting cached value:', error);
      // Don't throw error to avoid breaking the main functionality
    }
  }

  /**
   * Delete a value from the cache
   */
  async delete(key: string): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    try {
      await this.provider!.delete(this.getFullKey(key));
    } catch (error) {
      console.error('[CacheModule] Error deleting cached value:', error);
    }
  }

  /**
   * Check if a key exists in the cache
   */
  async has(key: string): Promise<boolean> {
    if (!this.isEnabled()) {
      return false;
    }

    try {
      return await this.provider!.has(this.getFullKey(key));
    } catch (error) {
      console.error('[CacheModule] Error checking cached value:', error);
      return false;
    }
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    try {
      await this.provider!.clear();
    } catch (error) {
      console.error('[CacheModule] Error clearing cache:', error);
    }
  }

  /**
   * Get all keys matching a pattern
   */
  async keys(pattern?: string): Promise<string[]> {
    if (!this.isEnabled()) {
      return [];
    }

    try {
      const fullPattern = pattern ? `${this.keyPrefix}${pattern}` : `${this.keyPrefix}*`;
      const keys = await this.provider!.keys(fullPattern);
      // Remove the prefix from the returned keys
      return keys.map(key => key.replace(this.keyPrefix, ''));
    } catch (error) {
      console.error('[CacheModule] Error getting cache keys:', error);
      return [];
    }
  }

  /**
   * Generate a cache key for contracts
   */
  getContractKey(userId: string): string {
    return `contract:${userId}`;
  }

  /**
   * Generate a cache key for features
   */
  getFeatureKey(userId: string, featureName: string): string {
    return `feature:${userId}:${featureName}`;
  }

  /**
   * Generate a cache key for subscriptions
   */
  getSubscriptionKey(userId: string): string {
    return `subscription:${userId}`;
  }

  /**
   * Generate a cache key for pricing tokens
   */
  getPricingTokenKey(userId: string): string {
    return `pricing-token:${userId}`;
  }

  /**
   * Invalidate all cache entries for a specific user
   */
  async invalidateUser(userId: string): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    try {
      const patterns = [
        `contract:${userId}`,
        `feature:${userId}:*`,
        `subscription:${userId}`,
        `pricing-token:${userId}`
      ];

      for (const pattern of patterns) {
        const keys = await this.keys(pattern);
        for (const key of keys) {
          await this.delete(key);
        }
      }
    } catch (error) {
      console.error('[CacheModule] Error invalidating user cache:', error);
    }
  }

  /**
   * Invalidate the cache entries of every user (contracts, evaluations, subscriptions, pricing
   * tokens), e.g. after contract events may have been missed.
   */
  async invalidateAllUsers(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    try {
      for (const pattern of ['contract:*', 'feature:*', 'subscription:*', 'pricing-token:*']) {
        const keys = await this.keys(pattern);
        for (const key of keys) {
          await this.delete(key);
        }
      }
    } catch (error) {
      console.error('[CacheModule] Error invalidating users cache:', error);
    }
  }

  /**
   * Close the cache connection and cleanup resources
   * This method is internal and should only be called by SpaceClient
   */
  async close(): Promise<void> {
    if (this.provider) {
      try {
        await this.provider.close();
      } catch (error) {
        console.error('[CacheModule] Error closing cache provider:', error);
      } finally {
        this.provider = null;
        this.enabled = false;
      }
    }
  }

  /**
   * Get the full cache key with prefix
   */
  private getFullKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }
}
