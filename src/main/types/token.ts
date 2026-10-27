import { FeatureEvaluationResult } from './features';
import { Subscription } from './contracts';

/**
 * The subscription a pricing token was issued for (claim `subscription`). Lets a browser that only
 * holds the token know the contracted versions, plans and add-ons without calling SPACE.
 */
export interface PricingTokenSubscription extends Subscription {
  /** The `contractVersion` of the contract when the token was issued. */
  contractVersion: string;
}

/**
 * The decoded payload of a pricing token issued by `features.generateUserPricingToken`.
 */
export interface PricingTokenPayload {
  /**
   * The subject of the token. Opaque: do not parse it, and do not use it as the userId. SPACE
   * versions with per-organization userIds (capability `contract-userid-per-org`) send
   * `urn:space:<organizationId>:<percent-encoded userId>`; older versions send the bare userId.
   * Use {@link pricingTokenUserId} (or the `userId` claim) to get the userId.
   */
  sub: string;
  /**
   * The userId of the contract, as stored in SPACE (not encoded). Absent in tokens issued by SPACE
   * versions without per-organization userIds, whose `sub` is the userId.
   */
  userId?: string;
  /** The organization of the contract. A userId is only unique within its organization. */
  organizationId?: string;
  /**
   * Audience: the organization the token was issued for (equal to `organizationId`). Absent in
   * tokens of older SPACE versions.
   */
  aud?: string | string[];
  /** Issuer: the SPACE server (its `JWT_ISSUER`, `space` by default). Absent in older tokens. */
  iss?: string;
  /** Issued at (seconds since epoch). */
  iat: number;
  /** Expiration (seconds since epoch). */
  exp: number;
  /** Evaluation of every feature of the user's contract, keyed by feature id. */
  features: Record<string, FeatureEvaluationResult>;
  pricingContext?: {
    features: Record<string, string | boolean>;
    usageLimits: Record<string, number | boolean>;
  };
  subscriptionContext?: Record<string, number>;
  /**
   * The subscription of the contract. Only present in tokens issued by SPACE versions that include
   * it; older tokens omit it.
   */
  subscription?: PricingTokenSubscription;
}
