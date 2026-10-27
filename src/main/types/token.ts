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
  /** The userId of the contract. */
  sub: string;
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
