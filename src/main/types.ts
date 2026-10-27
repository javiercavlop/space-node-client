import { CacheOptions } from './types/cache';
import { EventDeduplicationOptions } from './types/events';

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
   * Optional cache configuration
   */
  cache?: CacheOptions;

  /**
   * Drops repeated SPACE events by `eventId` (a consumer can receive one event more than once).
   * On by default, remembering the last 10,000 ids for up to 10 minutes; `false` turns it off.
   * Events without `eventId` (older SPACE) are always delivered.
   */
  eventDeduplication?: EventDeduplicationOptions | false;
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