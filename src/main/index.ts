export { connect } from './utils/connect';
export { SpaceClient } from './config/SpaceClient';
export {
  ContractChangedError,
  IdempotencyConflictError,
  IdempotencyError,
  IdempotencyInProgressError,
  IdempotencyKeyInvalidError,
  PricingYamlUnavailableError,
  SpaceFeatureUnsupportedError,
} from './errors';
export type { IdempotencyErrorCode } from './errors';

export * from './types';