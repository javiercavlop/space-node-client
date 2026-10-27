/**
 * Events of the `/pricings` namespace (no authentication needed).
 */
export type PricingEventName =
  | 'pricing_created'
  | 'pricing_archived'
  | 'pricing_actived'
  | 'service_disabled';

/**
 * Events of the authenticated `/contracts` namespace. The client only opens that namespace once a
 * listener for one of these events is registered, and SPACE only sends the events of the
 * organisation the API key belongs to.
 */
export type ContractEventName =
  | 'contract_created'
  | 'contract_novated'
  | 'contract_deleted'
  | 'contract_renewed';

/**
 * Connection events: `synchronized` (the `/pricings` namespace connected), `resync` (a namespace
 * connected or reconnected; see `ResyncInfo`) and `error`.
 */
export type ConnectionEventName = 'synchronized' | 'resync' | 'error';

export type SpaceClientEventName = ConnectionEventName | PricingEventName | ContractEventName;

export type ContractEventCode =
  | 'CONTRACT_CREATED'
  | 'CONTRACT_NOVATED'
  | 'CONTRACT_DELETED'
  | 'CONTRACT_RENEWED';

/**
 * Data passed to the listeners of contract events.
 */
export interface ContractEventDetails {
  userId: string;
  organizationId: string;
  /** The `contractVersion` after the change; `null` for `contract_deleted` (no contract left). */
  contractVersion: string | null;
  /** The services of the contract affected by the change. */
  services: string[];
}

/**
 * Data passed to the listeners of pricing events.
 */
export interface PricingEventDetails {
  serviceName: string;
  pricingVersion?: string;
}

/**
 * Top-level fields of a SPACE event other than `details`, passed to every pricing and contract
 * listener as its second argument.
 *
 * `eventId` and `occurredAt` are sent by SPACE versions with the `contract-event-ids` capability
 * and are `undefined` with older ones.
 */
export interface SpaceEventMeta {
  /** The event code as sent by SPACE, e.g. `CONTRACT_NOVATED`. */
  code: string;
  /**
   * Identifies the event: every copy of one event has the same `eventId`. The client already drops
   * repeats it has seen (see `SpaceConnectionOptions.eventDeduplication`). Compare it for equality
   * only, never to order events.
   */
  eventId?: string;
  /**
   * When SPACE stored the change, parsed from `rawOccurredAt`; `undefined` if it is missing or
   * not a valid date. It comes from the clock of the SPACE instance, so do not use it to order
   * events from different instances.
   */
  occurredAt?: Date;
  /** `occurredAt` exactly as SPACE sent it (ISO 8601, UTC, milliseconds). */
  rawOccurredAt?: string;
}

/**
 * Data passed to `resync` listeners. SPACE does not store or replay events, so whatever happened
 * while a namespace was disconnected is lost: re-read the contracts you hold (compare their
 * `contractVersion`) when this fires.
 */
export interface ResyncInfo {
  /** The namespace that connected: `contracts` (contract events) or `pricings`. */
  namespace: 'contracts' | 'pricings';
  /** `false` on its first connection, `true` when it connected again after being disconnected. */
  reconnect: boolean;
}

/**
 * Options of the per-client deduplication of SPACE events by `eventId`.
 */
export interface EventDeduplicationOptions {
  /** Set to `false` to deliver every copy (default `true`). */
  enabled?: boolean;
  /** At most this many ids are remembered; the oldest go first (default 10,000). */
  maxEntries?: number;
  /** An id is forgotten this long after it was first seen, in milliseconds (default 10 minutes). */
  windowMs?: number;
}
