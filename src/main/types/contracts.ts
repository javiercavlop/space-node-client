export interface FallbackSubscription {
  /**
   * The name of the plan to which the user will be subscribed after novation.
   */
  subscriptionPlan: string;
  /**
   * The set of add-ons that to which the user will be subscribed after novation.
   */
  subscriptionAddOns: Record<string, number>;
}

export interface ContractToCreate {
  userContact: {
    userId: string;
    username: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
  billingPeriod?: {
    autoRenew?: boolean;
    renewalDays?: number;
  };
  contractedServices: Record<string, string>; // service name → pricing path
  subscriptionPlans: Record<string, string>; // service name → plan name
  subscriptionAddOns: Record<string, Record<string, number>>; // service name → { addOn: count }
}

export type Subscription = Pick<
  ContractToCreate,
  'contractedServices' | 'subscriptionPlans' | 'subscriptionAddOns'
>;

export interface Contract {
  userContact: UserContact;
  billingPeriod: {
    startDate: Date;
    endDate: Date;
    autoRenew: boolean;
    renewalDays: number;
  };
  usageLevels: Record<string, Record<string, UsageLevel>>;
  contractedServices: Record<string, string>;
  subscriptionPlans: Record<string, string>;
  subscriptionAddOns: Record<string, Record<string, number>>;
  history: ContractHistoryEntry[];
  /**
   * Opaque version of the contract (also sent as the `ETag` header). Pass it as
   * `expectedContractVersion` to `updateContractSubscription` to reject concurrent changes.
   * Absent on SPACE versions without optimistic concurrency.
   */
  contractVersion?: string;
}

export interface UsageLevel {
  resetTimeStamp?: Date; // o Date si no es serializado
  consumed: number;
}

export interface ContractHistoryEntry {
  startDate: Date;
  endDate: Date;
  contractedServices: Record<string, string>;
  subscriptionPlans: Record<string, string>;
  subscriptionAddOns: Record<string, Record<string, number>>;
}

export interface UserContact {
  userId: string;
  username: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

/**
 * Body of a novation preview: same as a novation, but `contractedServices` may be omitted to mean
 * "keep the current versions or let the SPHERE policy decide".
 */
export type NovationRequest = Omit<Subscription, 'contractedServices'> &
  Partial<Pick<Subscription, 'contractedServices'>>;

export interface NovationPreviewOptions {
  /**
   * Keep the current billing period (start/end dates) instead of restarting it.
   * Sent as the query flag `keepBillingPeriod=true`. Default: the period restarts.
   */
  keepBillingPeriod?: boolean;
  /**
   * Ask SPACE to reject private plans and add-ons (codes `PRIVATE_PLAN` / `PRIVATE_ADDON`).
   * Sent as the query flag `rejectPrivate=true` only when `true`. Default: SPACE accepts them.
   * Needs the `reject-private` capability; without it the client refuses the call.
   */
  rejectPrivate?: boolean;
}

export interface UpdateContractSubscriptionOptions extends NovationPreviewOptions {
  /**
   * The `contractVersion` the change was computed against (from `getContract`, `getPricings` or
   * `previewNovation`). Sent as `If-Match`; if the contract changed meanwhile SPACE answers 412 and
   * the client throws `ContractChangedError`. Without it, the novation is unconditional.
   */
  expectedContractVersion?: string;
}

/**
 * Stable codes of novation validation errors.
 */
export type NovationErrorCode =
  | 'PLAN_NOT_FOUND'
  | 'ADDON_NOT_FOUND'
  | 'ADDON_NOT_AVAILABLE'
  | 'ADDON_DEPENDENCY_MISSING'
  | 'ADDON_EXCLUDED'
  | 'QUANTITY_OUT_OF_RANGE'
  | 'VERSION_NOT_FOUND'
  | 'VERSION_ARCHIVED'
  | 'PRIVATE_PLAN'
  | 'PRIVATE_ADDON';

export interface NovationError {
  /** One of `NovationErrorCode`; typed as `string` too so that new codes do not break callers. */
  code: NovationErrorCode | (string & {});
  service: string;
  /** Path of the offending value, e.g. `subscriptionAddOns.acme.extraStorage`. */
  path?: string;
  message: string;
}

export interface NovationVersionChange {
  from: string;
  to: string;
  /** Why the version changed, e.g. `requested` or `policy:all_last`. */
  reason: string;
}

export interface NovationUsageWarning {
  service: string;
  usageLimit: string;
  consumed: number;
  newLimit: number;
}

/**
 * Result of `POST /contracts/{userId}/novation/preview`: what a novation with the same body would
 * do, without writing anything. Feature/limit diffs and prices are not computed by SPACE.
 */
export interface NovationPreview {
  /** `false` when the novation would be rejected; `errors` then says why. */
  valid: boolean;
  errors: NovationError[];
  /** The subscription that would be stored after applying the SPHERE policy. */
  effective: Subscription;
  versionChanges: Record<string, NovationVersionChange>;
  /** Usage limits that would end up below current consumption (not an error). */
  usageWarnings: NovationUsageWarning[];
  billingPeriod: {
    startDate: string;
    endDate: string;
    /** `false` when `keepBillingPeriod` keeps the current period. */
    restarts: boolean;
  };
  /** The current `contractVersion`; pass it as `expectedContractVersion` when applying. */
  contractVersion: string;
}
