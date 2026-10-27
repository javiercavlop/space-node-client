/**
 * Options of the writes that SPACE can apply at most once (`Idempotency-Key`, capability
 * `idempotency-key`): consumptions, reverts, contract creation and novations.
 */
export interface WriteOptions {
  /**
   * The `Idempotency-Key` of this operation (1 to 255 characters). By default the client generates
   * a random UUID v4 per call and reuses it on its own retries. Pass your own key, stored with the
   * operation (e.g. in the job or outbox row that issues the call), when the operation may be retried
   * after the process restarts: SPACE then replays the first outcome instead of applying it again.
   * Never reuse a key for a different operation.
   *
   * With a key of your own the client checks that SPACE advertises `idempotency-key` and throws
   * `SpaceFeatureUnsupportedError` without writing if it does not (an older SPACE ignores the
   * header).
   */
  idempotencyKey?: string;
}
