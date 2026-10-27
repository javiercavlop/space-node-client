import axios from 'axios';
import { SpaceClient } from '../config/SpaceClient';
import { Contract, ContractPricings, ContractToCreate, Subscription } from '../types';

export class ContractModule {
  private spaceClient: SpaceClient;

  /**
   * Creates an instance of the `ContractModule` class.
   *
   * @param spaceClient - An instance of `SpaceClient` used to interact with the Space API.
   */
  constructor(spaceClient: SpaceClient) {
    this.spaceClient = spaceClient;
  }

  /**
   * Retrieves the contract for a specific user from the Space platform.
   * This method first checks the cache before making an API request.
   * 
   * @param userId - The ID of the user whose contract is to be retrieved.
   * @returns A promise that resolves with the user's contract data.
   * @throws An error if the operation fails.
   */
  public async getContract(userId: string): Promise<Contract> {
    const cache = this.spaceClient.getCache();
    const cacheKey = cache.getContractKey(userId);

    // Try to get from cache first
    if (cache.isEnabled()) {
      const cachedContract = await cache.get<Contract>(cacheKey);
      if (cachedContract) {
        return cachedContract;
      }
    }

    // If not in cache, fetch from API
    return axios
      .get(`${this.spaceClient.httpUrl}/contracts/${userId}`, {
        headers: {
          'x-api-key': this.spaceClient.apiKey,
        },
        timeout: this.spaceClient.timeout,
      })
      .then(async response => {
        const contract = response.data;
        
        // Cache the result if caching is enabled
        if (cache.isEnabled()) {
          await cache.set(cacheKey, contract);
        }
        
        return contract;
      })
      .catch(error => {
        console.error('Error fetching contract:', error.response.data);
        throw error;
      });
  }

  /**
   * Adds a new contract to the Space platform, so that evaluations for the user who owns the contract can be performed.
   * This method also invalidates any cached data for the user.
   *
   * @param contractToCreate - The contract details to be created.
   * @returns A promise that resolves with the response data from the Space API.
   * @throws An error if the operation fails.
   */
  public async addContract(contractToCreate: ContractToCreate): Promise<Contract> {
    return axios
      .post(`${this.spaceClient.httpUrl}/contracts`, contractToCreate, {
        headers: {
          'x-api-key': this.spaceClient.apiKey,
        },
        timeout: this.spaceClient.timeout,
      })
      .then(async response => {
        const contract = response.data;
        const cache = this.spaceClient.getCache();

        // Invalidate cache for this user if caching is enabled
        if (cache.isEnabled() && contract.userId) {
          await cache.invalidateUser(contract.userId);
          // Cache the new contract
          await cache.set(cache.getContractKey(contract.userId), contract);
        }

        return contract;
      })
      .catch(error => {
        console.error('Error adding contract:', error.response.data);
        throw error;
      });
  }

  /**
   * Updates the subscription for a user in the Space platform.
   * This method also invalidates the cached data for the user.
   *
   * @param userId - The ID of the user whose subscription is to be updated.
   * @param newSubscription - The new subscription details to be applied.
   * @returns A promise that resolves with the response data from the Space API.
   * @throws An error if the operation fails.
   */
  public async updateContractSubscription(
    userId: string,
    newSubscription: Subscription
  ): Promise<Contract> {
    return axios
      .put(`${this.spaceClient.httpUrl}/contracts/${userId}`, newSubscription, {
        headers: {
          'x-api-key': this.spaceClient.apiKey,
        },
        timeout: this.spaceClient.timeout,
      })
      .then(async response => {
        const contract = response.data;
        const cache = this.spaceClient.getCache();

        // Invalidate and update cache for this user if caching is enabled
        if (cache.isEnabled()) {
          await cache.invalidateUser(userId);
          await cache.set(cache.getContractKey(userId), contract);
        }

        return contract;
      })
      .catch(error => {
        console.error('Error updating contract subscription:', error.response.data);
        throw error;
      });
  }

  /**
   * Retrieves the pricing version of every service of a user's contract, together with the
   * version SPACE assigns to new contracts and the current `contractVersion`
   * (`GET /contracts/{userId}/pricings`). Use it to render the pricing page of a signed-in customer
   * with the version of THEIR contract.
   *
   * @param userId - The ID of the user whose contract pricings are to be retrieved.
   * @returns A promise that resolves with the pricings of the contract.
   * @throws An error if the operation fails (404 if the contract is not in the caller organisation).
   */
  public async getPricings(userId: string): Promise<ContractPricings> {
    return axios
      .get(`${this.spaceClient.httpUrl}/contracts/${encodeURIComponent(userId)}/pricings`, {
        headers: {
          'x-api-key': this.spaceClient.apiKey,
        },
        timeout: this.spaceClient.timeout,
      })
      .then(response => response.data)
      .catch(error => {
        console.error('Error fetching contract pricings:', error.response?.data ?? error.message);
        throw error;
      });
  }
}
