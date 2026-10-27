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
   * Optional timeout for the connection in milliseconds.
   */
  timeout?: number;

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