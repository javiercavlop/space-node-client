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

export type ConnectionEventName = 'synchronized' | 'error';

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
  /** The `contractVersion` after the change (for `contract_deleted`, the last one). */
  contractVersion: string;
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
