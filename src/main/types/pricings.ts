/**
 * Options for `pricings.getYaml`.
 */
export interface GetPricingYamlOptions {
  /**
   * The ETag of a copy the caller already holds (as returned in a previous `PricingYaml.etag`).
   * When given, it is sent as `If-None-Match` and SPACE answers `304 Not Modified` if the file
   * has not changed. Quotes are added if missing.
   */
  etag?: string;
}

/**
 * The raw Pricing2Yaml file of a pricing version, as stored by SPACE.
 */
export interface PricingYaml {
  /**
   * The Pricing2Yaml file, byte for byte. `null` when `notModified` is `true`.
   */
  yaml: string | null;
  /**
   * The strong ETag of the file (`"<sha256 hex>"`), or `null` if SPACE did not send one.
   */
  etag: string | null;
  /**
   * The `syntaxVersion` declared in the file (header `X-Pricing-Syntax-Version`), or `null`.
   */
  syntaxVersion: string | null;
  /**
   * `true` when the `etag` given in the options still matches (HTTP 304) and no body was sent.
   */
  notModified: boolean;
}

export type PricingStatus = 'active' | 'archived';

/**
 * The pricing version a contract holds for one of its services.
 */
export interface ContractServicePricing {
  /** The version in `contract.contractedServices[service]`, unescaped. */
  version: string;
  /** Whether that version is still active or has been archived. */
  status: PricingStatus;
  /** Path of the raw Pricing2Yaml of that version (see `pricings.getYaml`). */
  yamlUrl: string;
  /** The version SPACE assigns to new contracts of the service, or `null` if unknown. */
  newContractsVersion: string | null;
  /** The plan the contract is subscribed to, if any. */
  plan?: string;
  /** The add-ons (and quantities) the contract is subscribed to. */
  addOns?: Record<string, number>;
}

/**
 * Response of `GET /contracts/{userId}/pricings`.
 */
export interface ContractPricings {
  services: Record<string, ContractServicePricing>;
  /** Opaque version of the contract, usable as `expectedContractVersion` in a novation. */
  contractVersion: string;
}

export type NewContractsPricingSource = 'sphere-policy' | 'default' | 'latest-active';

/**
 * Response of `GET /services/{serviceName}/pricings/new-contracts`.
 */
export interface NewContractsPricing {
  /** The pricing version used for contracts created from now on. */
  version: string;
  /** Path of the raw Pricing2Yaml of that version (see `pricings.getYaml`). */
  yamlUrl: string;
  /**
   * How SPACE chose it: the SPHERE sync policy, the service `defaultVersion`, or (fallback) the most
   * recently created active version.
   */
  source: NewContractsPricingSource;
}
