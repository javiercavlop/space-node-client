import axios from 'axios';
import { SpaceClient } from '../config/SpaceClient';
import { ContractChangedError } from '../errors';
import {
  Contract,
  ContractPricings,
  ContractToCreate,
  NovationPreview,
  NovationPreviewOptions,
  NovationRequest,
  Subscription,
  UpdateContractSubscriptionOptions,
} from '../types';

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
   * Updates the subscription for a user in the Space platform (novation).
   * This method also invalidates the cached data for the user.
   *
   * @param userId - The ID of the user whose subscription is to be updated.
   * @param newSubscription - The new subscription details to be applied.
   * @param options - Optional novation options:
   *   - `expectedContractVersion`: sent as `If-Match`; a concurrent change makes SPACE answer 412
   *     and this method throw `ContractChangedError`.
   *   - `keepBillingPeriod`: keep the current billing period instead of restarting it.
   * @returns A promise that resolves with the response data from the Space API.
   * @throws `ContractChangedError` if `expectedContractVersion` no longer matches.
   * @throws An error if the operation fails.
   */
  public async updateContractSubscription(
    userId: string,
    newSubscription: Subscription,
    options: UpdateContractSubscriptionOptions = {}
  ): Promise<Contract> {
    const headers: Record<string, string> = {
      'x-api-key': this.spaceClient.apiKey,
    };
    if (options.expectedContractVersion !== undefined) {
      headers['If-Match'] = toEtag(options.expectedContractVersion);
    }

    return axios
      .put(`${this.spaceClient.httpUrl}/contracts/${userId}`, newSubscription, {
        params: novationParams(options),
        headers,
        timeout: this.spaceClient.timeout,
      })
      .then(async response => {
        const contract = withContractVersion(response.data, response.headers['etag']);
        const cache = this.spaceClient.getCache();

        // Invalidate and update cache for this user if caching is enabled
        if (cache.isEnabled()) {
          await cache.invalidateUser(userId);
          await cache.set(cache.getContractKey(userId), contract);
        }

        return contract;
      })
      .catch(async error => {
        if (error.response?.status === 412) {
          // Whatever we have cached for this user is known to be stale.
          await this.spaceClient.getCache().invalidateUser(userId);
          const data = error.response.data ?? {};
          const current =
            data.contractVersion ?? fromEtag(error.response.headers?.['etag']) ?? null;
          throw new ContractChangedError(userId, options.expectedContractVersion, current, error);
        }
        console.error(
          'Error updating contract subscription:',
          error.response?.data ?? error.message
        );
        throw error;
      });
  }

  /**
   * Previews a novation without applying it (`POST /contracts/{userId}/novation/preview`).
   * SPACE runs the same policy and validation as `updateContractSubscription` and writes nothing.
   * An invalid subscription is reported as `valid: false` with `errors`, not thrown.
   *
   * @param userId - The ID of the user whose subscription would change.
   * @param newSubscription - The candidate subscription; `contractedServices` may be omitted.
   * @param options - `keepBillingPeriod` to preview keeping the current billing period.
   * @returns A promise that resolves with the preview, including the current `contractVersion`.
   * @throws An error if the operation fails (e.g. 404 contract not found).
   */
  public async previewNovation(
    userId: string,
    newSubscription: NovationRequest,
    options: NovationPreviewOptions = {}
  ): Promise<NovationPreview> {
    return axios
      .post(
        `${this.spaceClient.httpUrl}/contracts/${encodeURIComponent(userId)}/novation/preview`,
        newSubscription,
        {
          params: novationParams(options),
          headers: {
            'x-api-key': this.spaceClient.apiKey,
          },
          timeout: this.spaceClient.timeout,
        }
      )
      .then(response => response.data)
      .catch(error => {
        console.error('Error previewing novation:', error.response?.data ?? error.message);
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

function novationParams(options: NovationPreviewOptions): Record<string, string> | undefined {
  return options.keepBillingPeriod ? { keepBillingPeriod: 'true' } : undefined;
}

function toEtag(contractVersion: string): string {
  return /^(W\/)?".*"$/.test(contractVersion) ? contractVersion : `"${contractVersion}"`;
}

function fromEtag(etag: string | undefined): string | undefined {
  if (!etag) {
    return undefined;
  }
  return etag.replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

function withContractVersion(contract: Contract, etag: string | undefined): Contract {
  if (contract && typeof contract === 'object' && contract.contractVersion === undefined) {
    const fromHeader = fromEtag(etag);
    if (fromHeader !== undefined) {
      return { ...contract, contractVersion: fromHeader };
    }
  }
  return contract;
}
