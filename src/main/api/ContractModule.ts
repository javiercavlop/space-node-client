import axios from 'axios';
import { SpaceClient } from '../config/SpaceClient';
import { ContractChangedError, SpaceFeatureUnsupportedError } from '../errors';
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
      .get(`${this.spaceClient.httpUrl}/contracts/${encodeURIComponent(userId)}`, {
        headers: {
          'x-api-key': this.spaceClient.apiKey,
        },
        timeout: this.spaceClient.timeout,
      })
      .then(async response => {
        this.spaceClient.observeCapabilities(response.headers);
        const contract = withContractVersion(response.data, response.headers['etag']);

        // Cache the result if caching is enabled
        if (cache.isEnabled()) {
          await cache.set(cacheKey, contract);
        }

        return contract;
      })
      .catch(error => {
        console.error('Error fetching contract:', error.response?.data ?? error.message);
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
   *   - `rejectPrivate`: ask SPACE to reject private plans and add-ons (opt-in, default false).
   *
   *   These guarantees need server support (`X-Space-Capabilities` tokens `contract-version`,
   *   `keep-billing-period` and `reject-private`). Before writing, the client checks them (cached per client for
   *   `SpaceClient.CAPABILITIES_TTL_MS`; when unknown, it reads the contract once, which also lets it
   *   reject a stale `expectedContractVersion` early) and throws `SpaceFeatureUnsupportedError`
   *   without writing if one is missing. After writing, it throws `SpaceFeatureUnsupportedError`
   *   with `written: true` if the response shows the guarantee was not honoured (no `ETag`, or the
   *   billing period restarted).
   * @returns A promise that resolves with the response data from the Space API.
   * @throws `ContractChangedError` if `expectedContractVersion` no longer matches.
   * @throws `SpaceFeatureUnsupportedError` if SPACE does not support a requested option.
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

    const before = await this.ensureNovationSupport(userId, options);

    return axios
      .put(`${this.spaceClient.httpUrl}/contracts/${encodeURIComponent(userId)}`, newSubscription, {
        params: novationParams(options),
        headers,
        timeout: this.spaceClient.timeout,
      })
      .then(async response => {
        this.spaceClient.observeCapabilities(response.headers);
        const contract = withContractVersion(response.data, response.headers['etag']);
        const cache = this.spaceClient.getCache();

        const unhonoured = unhonouredOption(options, response.headers['etag'], contract, before);
        if (unhonoured) {
          // SPACE wrote the novation without the requested guarantee: report it, and do not keep
          // anything cached for this user.
          await cache.invalidateUser(userId);
          throw new SpaceFeatureUnsupportedError(unhonoured.capability, unhonoured.message, {
            written: true,
            contract,
          });
        }

        // Invalidate and update cache for this user if caching is enabled
        if (cache.isEnabled()) {
          await cache.invalidateUser(userId);
          await cache.set(cache.getContractKey(userId), contract);
        }

        return contract;
      })
      .catch(async error => {
        if (error instanceof SpaceFeatureUnsupportedError) {
          throw error;
        }
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
   * @param options - `keepBillingPeriod` to preview keeping the current billing period;
   *   `rejectPrivate` to have private plans and add-ons reported as errors.
   * @returns A promise that resolves with the preview, including the current `contractVersion`.
   * @throws `SpaceFeatureUnsupportedError` if the answering SPACE does not advertise the
   *   capability of a requested option (`keep-billing-period`, `reject-private`).
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
      .then(response => {
        this.spaceClient.observeCapabilities(response.headers);
        // The preview would describe a restart, or accept private plans, while the caller asked
        // otherwise.
        const capabilities = this.spaceClient.getCachedCapabilities();
        const missing = requiredCapabilities(options).find(
          capability => !capabilities?.has(capability)
        );
        if (missing) {
          throw new SpaceFeatureUnsupportedError(
            missing,
            `The connected SPACE does not support ${OPTION_OF[missing]}: the preview ignored it`
          );
        }
        return response.data;
      })
      .catch(error => {
        if (error instanceof SpaceFeatureUnsupportedError) {
          throw error;
        }
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
      .then(response => {
        this.spaceClient.observeCapabilities(response.headers);
        return response.data;
      })
      .catch(error => {
        console.error('Error fetching contract pricings:', error.response?.data ?? error.message);
        throw error;
      });
  }

  /**
   * Makes sure the connected SPACE honours the requested novation options before anything is
   * written (S0). When the capabilities are not cached, reads the contract once: its response
   * carries them, and its `ETag` lets a stale `expectedContractVersion` fail before the write.
   *
   * @returns The contract read for the check, if one was needed.
   */
  private async ensureNovationSupport(
    userId: string,
    options: UpdateContractSubscriptionOptions
  ): Promise<Contract | undefined> {
    const required = requiredCapabilities(options);
    if (required.length === 0) {
      return undefined;
    }

    let current: Contract | undefined;
    let currentVersion: string | undefined;
    let capabilities = this.spaceClient.getCachedCapabilities();
    if (!capabilities) {
      const response = await axios
        .get(`${this.spaceClient.httpUrl}/contracts/${encodeURIComponent(userId)}`, {
          headers: {
            'x-api-key': this.spaceClient.apiKey,
          },
          timeout: this.spaceClient.timeout,
        })
        .catch(error => {
          console.error(
            'Error reading contract before novation:',
            error.response?.data ?? error.message
          );
          throw error;
        });
      this.spaceClient.observeCapabilities(response.headers);
      capabilities = this.spaceClient.getCachedCapabilities() ?? new Set<string>();
      current = withContractVersion(response.data, response.headers['etag']);
      currentVersion = fromEtag(response.headers['etag']) ?? current?.contractVersion;
    }

    const missing = required.find(capability => !capabilities.has(capability));
    if (missing) {
      throw new SpaceFeatureUnsupportedError(
        missing,
        `The connected SPACE does not support ${OPTION_OF[missing]}: nothing was written`
      );
    }

    // Early, non-atomic check; If-Match on the PUT stays the atomic one.
    if (
      currentVersion !== undefined &&
      options.expectedContractVersion !== undefined &&
      currentVersion !== fromEtag(options.expectedContractVersion)
    ) {
      await this.spaceClient.getCache().invalidateUser(userId);
      throw new ContractChangedError(userId, options.expectedContractVersion, currentVersion);
    }

    return current;
  }
}

const CONTRACT_VERSION = 'contract-version';
const KEEP_BILLING_PERIOD = 'keep-billing-period';
const REJECT_PRIVATE = 'reject-private';
const OPTION_OF: Record<string, string> = {
  [CONTRACT_VERSION]: 'expectedContractVersion (If-Match)',
  [KEEP_BILLING_PERIOD]: 'keepBillingPeriod',
  [REJECT_PRIVATE]: 'rejectPrivate',
};

function requiredCapabilities(options: UpdateContractSubscriptionOptions): string[] {
  const required: string[] = [];
  if (options.expectedContractVersion !== undefined) {
    required.push(CONTRACT_VERSION);
  }
  if (options.keepBillingPeriod) {
    required.push(KEEP_BILLING_PERIOD);
  }
  if (options.rejectPrivate) {
    required.push(REJECT_PRIVATE);
  }
  return required;
}

/**
 * Post-write backstop: tells whether the stored contract shows that SPACE ignored an option.
 * The previous start date comes from the pre-write read or, failing that, from the history entry
 * the novation pushed (SPACE records the replaced period there).
 */
function unhonouredOption(
  options: UpdateContractSubscriptionOptions,
  etag: string | undefined,
  contract: Contract,
  before: Contract | undefined
): { capability: string; message: string } | undefined {
  if (options.expectedContractVersion !== undefined && !etag) {
    return {
      capability: CONTRACT_VERSION,
      message:
        'SPACE applied the novation without an ETag: If-Match (expectedContractVersion) was not enforced',
    };
  }
  if (options.keepBillingPeriod) {
    const previousStart =
      before?.billingPeriod?.startDate ?? contract?.history?.[contract.history.length - 1]?.startDate;
    const newStart = contract?.billingPeriod?.startDate;
    if (
      previousStart !== undefined &&
      newStart !== undefined &&
      new Date(previousStart).getTime() !== new Date(newStart).getTime()
    ) {
      return {
        capability: KEEP_BILLING_PERIOD,
        message: 'SPACE applied the novation but restarted the billing period (keepBillingPeriod ignored)',
      };
    }
  }
  return undefined;
}

function novationParams(options: NovationPreviewOptions): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  if (options.keepBillingPeriod) {
    params.keepBillingPeriod = 'true';
  }
  if (options.rejectPrivate) {
    params.rejectPrivate = 'true';
  }
  return Object.keys(params).length > 0 ? params : undefined;
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
