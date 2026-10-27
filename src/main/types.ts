import { CacheOptions } from './types/cache';

export interface SpaceConnectionOptions {
  /**
   * The URL of the Space server to connect to.
   */
  url: string;

  /**
   * The API key for authentication.
   */
  apiKey: string;

  /**
   * The organisation to act in when `apiKey` is a member user key (`usr_...`). Sent with the
   * handshake of the authenticated `/contracts` events namespace (`{ apiKey, organizationId }`),
   * which SPACE requires for user keys. Not needed for organisation keys.
   */
  organizationId?: string;

  /**
   * Optional timeout for the connection in milliseconds.
   */
  timeout?: number;

  /**
   * How many times the client retries a write that carries an `Idempotency-Key` (consumptions,
   * reverts, contract creation, novations) after a network error, a `5xx` or a
   * `409 IDEMPOTENCY_IN_PROGRESS`, with the same key. Integer from 0 to 10; default 0 (no retries).
   * Retries only happen while SPACE advertises the `idempotency-key` capability, since an older
   * SPACE would apply a retried write twice. Other requests are never retried.
   */
  retries?: number;

  /**
   * Base delay of the exponential backoff between retries, in milliseconds (default 250). The
   * n-th retry waits between half and all of `retryBaseDelayMs * 2^(n-1)`, capped at
   * `retryMaxDelayMs`. A `Retry-After` from SPACE is waited exactly instead.
   */
  retryBaseDelayMs?: number;

  /**
   * Longest wait before a retry, in milliseconds (default 10000). A `Retry-After` longer than this
   * ends the retries: the client never waits less than SPACE asks.
   */
  retryMaxDelayMs?: number;

  /**
   * Optional cache configuration
   */
  cache?: CacheOptions;
}

export type SpaceEvent =
  | "PRICING_CREATED"
  | "PRICING_ARCHIVED"
  | "PRICING_ACTIVED"
  | "SERVICE_DISABLED"
  | "CONTRACT_CREATED"
  | "CONTRACT_NOVATED"
  | "CONTRACT_DELETED"
  | "CONTRACT_RENEWED";

export * from './types/contracts';
export * from './types/features';
export * from './types/cache';
export * from './types/pricings';
export * from './types/events';
export * from './types/token';
export * from './types/idempotency';