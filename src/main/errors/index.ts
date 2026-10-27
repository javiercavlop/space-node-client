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

/** The `code` SPACE puts in the body of an `Idempotency-Key` refusal. */
export type IdempotencyErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'IDEMPOTENCY_KEY_INVALID';

/**
 * SPACE refused a write because of its `Idempotency-Key` (capability `idempotency-key`). Nothing
 * was applied by this request. `cause` is the underlying HTTP error.
 */
export class IdempotencyError extends Error {
  constructor(
    public readonly code: IdempotencyErrorCode,
    /** HTTP status of the refusal (409 or 400). */
    public readonly status: number,
    /** The key the request carried. */
    public readonly idempotencyKey: string,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'IdempotencyError';
  }
}

/**
 * `409 IDEMPOTENCY_CONFLICT`: the key was already used for a different request (another body,
 * query, route or `If-Match`). Nothing was applied. Use a new key for a new operation; reusing a key
 * for another operation is a bug of the caller.
 */
export class IdempotencyConflictError extends IdempotencyError {
  constructor(idempotencyKey: string, message?: string, cause?: unknown) {
    super(
      'IDEMPOTENCY_CONFLICT',
      409,
      idempotencyKey,
      message ?? `Idempotency-Key ${idempotencyKey} was already used for a different request`,
      cause
    );
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * `409 IDEMPOTENCY_IN_PROGRESS`: a request with the same key is still running in SPACE, and the
 * client's retries (if any) are spent. Retry later with the SAME key: SPACE then replays the
 * outcome of the running request. `retryAfter` is SPACE's `Retry-After`, in seconds.
 */
export class IdempotencyInProgressError extends IdempotencyError {
  constructor(
    idempotencyKey: string,
    public readonly retryAfter?: number,
    message?: string,
    cause?: unknown
  ) {
    super(
      'IDEMPOTENCY_IN_PROGRESS',
      409,
      idempotencyKey,
      message ?? `A request with Idempotency-Key ${idempotencyKey} is still being processed`,
      cause
    );
    this.name = 'IdempotencyInProgressError';
  }
}

/** `400 IDEMPOTENCY_KEY_INVALID`: SPACE rejected the key (it must have 1 to 255 characters). */
export class IdempotencyKeyInvalidError extends IdempotencyError {
  constructor(idempotencyKey: string, message?: string, cause?: unknown) {
    super(
      'IDEMPOTENCY_KEY_INVALID',
      400,
      idempotencyKey,
      message ?? 'Idempotency-Key must have between 1 and 255 characters',
      cause
    );
    this.name = 'IdempotencyKeyInvalidError';
  }
}
