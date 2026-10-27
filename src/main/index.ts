export { connect } from './utils/connect';
export { SpaceClient } from './config/SpaceClient';
export { pricingTokenUserId } from './utils/token';
export {
  DEFAULT_PRICING_TOKEN_ISSUER,
  PRICING_TOKEN_JWKS,
  PricingTokenVerifier,
  type PricingTokenVerifierOptions,
  type VerifyPricingTokenOptions,
} from './api/PricingTokenVerifier';
export {
  ContractChangedError,
  PricingTokenAudienceError,
  PricingTokenExpiredError,
  PricingTokenIssuerError,
  PricingTokenSignatureError,
  PricingTokenUnknownKeyError,
  PricingTokenVerificationError,
  type PricingTokenVerificationErrorCode,
  PricingYamlUnavailableError,
  SpaceFeatureUnsupportedError,
} from './errors';

export * from './types';