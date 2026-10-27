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

/** The `code` of a {@link PricingTokenVerificationError}. */
export type PricingTokenVerificationErrorCode =
  | 'PRICING_TOKEN_INVALID'
  | 'PRICING_TOKEN_SIGNATURE_INVALID'
  | 'PRICING_TOKEN_EXPIRED'
  | 'PRICING_TOKEN_WRONG_AUDIENCE'
  | 'PRICING_TOKEN_WRONG_ISSUER'
  | 'PRICING_TOKEN_UNKNOWN_KID'
  | 'PRICING_TOKEN_JWKS_UNAVAILABLE';

/**
 * Thrown by `PricingTokenVerifier.verify` (and `features.verifyPricingToken`) when a pricing token
 * cannot be trusted. The subclasses name the usual reasons; this class itself is used for malformed
 * tokens, algorithms other than ES256, `jwk`/`jku`/`x5u`/`x5c` headers, missing or invalid claims
 * (`PRICING_TOKEN_INVALID`) and for a JWKS that could not be fetched
 * (`PRICING_TOKEN_JWKS_UNAVAILABLE`).
 */
export class PricingTokenVerificationError extends Error {
  constructor(
    public readonly code: PricingTokenVerificationErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'PricingTokenVerificationError';
  }
}

/** The signature does not match the published key the token names (forged or tampered token). */
export class PricingTokenSignatureError extends PricingTokenVerificationError {
  constructor(cause?: unknown) {
    super('PRICING_TOKEN_SIGNATURE_INVALID', 'The pricing token signature is invalid', cause);
    this.name = 'PricingTokenSignatureError';
  }
}

/** The token expired (`exp`, after the configured clock tolerance). */
export class PricingTokenExpiredError extends PricingTokenVerificationError {
  constructor(
    /** When the token expired, if it says so. */
    public readonly expiredAt: Date | undefined,
    cause?: unknown
  ) {
    super('PRICING_TOKEN_EXPIRED', 'The pricing token has expired', cause);
    this.name = 'PricingTokenExpiredError';
  }
}

/** The token was issued for another organization (`aud` or `organizationId`). */
export class PricingTokenAudienceError extends PricingTokenVerificationError {
  constructor(
    /** The organization the token had to be issued for. */
    public readonly expected: string,
    /** The `aud` or `organizationId` the token carries (may be missing). */
    public readonly actual: unknown,
    cause?: unknown
  ) {
    super('PRICING_TOKEN_WRONG_AUDIENCE', `The pricing token was not issued for organization ${expected}`, cause);
    this.name = 'PricingTokenAudienceError';
  }
}

/** The token was issued by another server (`iss`). */
export class PricingTokenIssuerError extends PricingTokenVerificationError {
  constructor(
    public readonly expected: string,
    public readonly actual: unknown,
    cause?: unknown
  ) {
    super('PRICING_TOKEN_WRONG_ISSUER', `The pricing token was not issued by ${expected}`, cause);
    this.name = 'PricingTokenIssuerError';
  }
}

/**
 * The token names a `kid` that SPACE does not publish, even after fetching the JWKS again: a key
 * that was removed (rotation or leaked key) or a token that SPACE did not sign.
 */
export class PricingTokenUnknownKeyError extends PricingTokenVerificationError {
  constructor(
    public readonly kid: string,
    cause?: unknown
  ) {
    super('PRICING_TOKEN_UNKNOWN_KID', `SPACE does not publish the key "${kid}" of this pricing token`, cause);
    this.name = 'PricingTokenUnknownKeyError';
  }
}
