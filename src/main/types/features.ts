import type { WriteOptions } from './idempotency';

export interface FeatureEvaluationResult {
  eval: boolean;
  used: Record<string, number | boolean> | null;
  limit: Record<string, number | boolean> | null;
  error: {
    code: string;
    message: string;
  } | null;
  /**
   * Only when this evaluation applied an expected consumption, on a SPACE with the
   * `atomic-usage-limits` capability: the id to revert exactly that consumption with
   * `features.revertConsumption`. The same id is returned when SPACE replays the request.
   */
  consumptionId?: string;
}

export interface EvaluateOptions extends WriteOptions {
  details?: boolean;
  server?: boolean;
}