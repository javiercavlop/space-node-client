import type { Contract } from '../types';

/**
 * Thrown by `pricings.getYaml` when SPACE knows the pricing version but cannot provide its original
 * Pricing2Yaml file (`404 {error: "PRICING_YAML_UNAVAILABLE"}`), e.g. a historical SPHERE-linked
 * version that SPACE only keeps as parsed JSON.
 */
export class PricingYamlUnavailableError extends Error {
  public readonly code = 'PRICING_YAML_UNAVAILABLE';

  constructor(
    public readonly serviceName: string,
    public readonly pricingVersion: string,
    public readonly cause?: unknown
  ) {
    super(`The Pricing2Yaml of ${serviceName}@${pricingVersion} is not available in SPACE`);
    this.name = 'PricingYamlUnavailableError';
  }
}

/**
 * Thrown when the connected SPACE does not implement a feature the call depends on, instead of
 * silently returning something else or writing without the requested guarantee. `capability` is the
 * `X-Space-Capabilities` token of the missing feature (e.g. `pricing-yaml`).
 *
 * `written` tells whether SPACE already applied a write: `false` when the client refused before
 * sending it (capability check), `true` when the response showed the guarantee was not honoured
 * (post-write backstop). In the latter case `contract` is the contract SPACE stored.
 */
export class SpaceFeatureUnsupportedError extends Error {
  public readonly code = 'SPACE_FEATURE_UNSUPPORTED';
  public readonly written: boolean;
  public readonly contract?: Contract;

  constructor(
    public readonly capability: string,
    message?: string,
    details: { written?: boolean; contract?: Contract } = {}
  ) {
    super(message ?? `The connected SPACE does not support "${capability}"`);
    this.name = 'SpaceFeatureUnsupportedError';
    this.written = details.written ?? false;
    this.contract = details.contract;
  }
}

/**
 * Thrown by `contracts.updateContractSubscription` when `expectedContractVersion` no longer matches
 * the contract stored in SPACE (`412 {error: "CONTRACT_CHANGED"}`): someone else changed it in the
 * meantime. Re-read the contract (or preview again) and ask the user to confirm the new situation.
 */
export class ContractChangedError extends Error {
  public readonly code = 'CONTRACT_CHANGED';

  constructor(
    public readonly userId: string,
    /** The version the caller expected. */
    public readonly expectedContractVersion: string | undefined,
    /** The current version in SPACE, or `null` if SPACE did not report it. */
    public readonly contractVersion: string | null,
    public readonly cause?: unknown
  ) {
    super(
      `The contract of user ${userId} changed (expected ${expectedContractVersion ?? 'unknown'}, current ${contractVersion ?? 'unknown'})`
    );
    this.name = 'ContractChangedError';
  }
}
