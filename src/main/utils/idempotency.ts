import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { randomUUID } from 'node:crypto';
import type { SpaceClient } from '../config/SpaceClient';
import {
  IdempotencyConflictError,
  IdempotencyError,
  IdempotencyInProgressError,
  IdempotencyKeyInvalidError,
  SpaceFeatureUnsupportedError,
} from '../errors';

/** Capability token of the `Idempotency-Key` header (SCORELabUS/space#85). */
export const IDEMPOTENCY_KEY = 'idempotency-key';
/** Capability token of bounded consumptions and revert by `consumptionId` (SCORELabUS/space#84). */
export const ATOMIC_USAGE_LIMITS = 'atomic-usage-limits';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
const MAX_KEY_LENGTH = 255;

/** Throws a `TypeError` unless `value` is a string of 1 to 255 characters. */
export function checkId(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_KEY_LENGTH) {
    throw new TypeError(`${name} must be a string of 1 to ${MAX_KEY_LENGTH} characters`);
  }
}

/**
 * Sends a write that SPACE applies at most once per `Idempotency-Key`.
 *
 * - The key is the caller's (checked, and refused with `SpaceFeatureUnsupportedError` before
 *   anything is sent if SPACE does not advertise `idempotency-key`) or a new UUID v4. It is the
 *   same on every attempt, as are the method, URL, query and body, so SPACE sees one operation.
 * - Up to `client.retries` retries after a network error, a `5xx` or a
 *   `409 IDEMPOTENCY_IN_PROGRESS`, only while SPACE advertises `idempotency-key` (an older SPACE
 *   would apply each attempt). `Retry-After` is waited exactly; without it, exponential backoff
 *   with jitter. Other `4xx` are never retried.
 * - Idempotency refusals become `IdempotencyConflictError`, `IdempotencyInProgressError` and
 *   `IdempotencyKeyInvalidError`; any other failure is rethrown as it came (an axios error).
 */
export async function sendKeyedWrite<T = any>(
  client: SpaceClient,
  config: AxiosRequestConfig,
  idempotencyKey?: string
): Promise<AxiosResponse<T>> {
  if (idempotencyKey !== undefined) {
    checkId(idempotencyKey, 'idempotencyKey');
    if (!(await client.hasCapability(IDEMPOTENCY_KEY))) {
      throw new SpaceFeatureUnsupportedError(
        IDEMPOTENCY_KEY,
        'The connected SPACE does not support Idempotency-Key: nothing was written'
      );
    }
  }
  const key = idempotencyKey ?? randomUUID();
  const request: AxiosRequestConfig = {
    ...config,
    headers: { ...(config.headers as Record<string, string>), [IDEMPOTENCY_KEY_HEADER]: key },
  };

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await axios.request<T>(request);
      client.observeCapabilities(response.headers);
      return response;
    } catch (error) {
      const response = axios.isAxiosError(error) ? error.response : undefined;
      if (response) {
        client.observeCapabilities(response.headers, false);
      }
      const typed = idempotencyErrorOf(error, key);
      const retryAfter = response ? parseRetryAfter(readHeader(response.headers, 'retry-after')) : undefined;
      const retryable =
        typed instanceof IdempotencyInProgressError ||
        (typed === undefined && isTransient(error));
      if (retryable && attempt < client.retries) {
        const delay = retryDelay(client, attempt, retryAfter);
        if (delay !== undefined && (await client.hasCapability(IDEMPOTENCY_KEY))) {
          await client.sleep(delay);
          continue;
        }
      }
      throw typed ?? error;
    }
  }
}

/** A network error (no answer) or a `5xx`: the write may or may not have run. */
function isTransient(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }
  if (error.response) {
    return error.response.status >= 500;
  }
  return error.code !== 'ERR_CANCELED' && error.request !== undefined;
}

function idempotencyErrorOf(error: unknown, key: string): IdempotencyError | undefined {
  if (!axios.isAxiosError(error) || !error.response) {
    return undefined;
  }
  const { status, data, headers } = error.response;
  const code = data && typeof data === 'object' ? (data as any).code : undefined;
  const message = data && typeof data === 'object' && typeof (data as any).error === 'string'
    ? (data as any).error
    : undefined;
  if (status === 409 && code === 'IDEMPOTENCY_CONFLICT') {
    return new IdempotencyConflictError(key, message, error);
  }
  if (status === 409 && code === 'IDEMPOTENCY_IN_PROGRESS') {
    return new IdempotencyInProgressError(
      key,
      parseRetryAfter(readHeader(headers, 'retry-after')),
      message,
      error
    );
  }
  if (status === 400 && code === 'IDEMPOTENCY_KEY_INVALID') {
    return new IdempotencyKeyInvalidError(key, message, error);
  }
  return undefined;
}

/**
 * How long to wait before retry number `attempt + 1`, or `undefined` to stop: `Retry-After` when
 * SPACE sent one (stop if it is longer than `retryMaxDelayMs`), otherwise exponential backoff with
 * jitter, capped at `retryMaxDelayMs`.
 */
function retryDelay(client: SpaceClient, attempt: number, retryAfterSeconds?: number): number | undefined {
  if (retryAfterSeconds !== undefined) {
    const ms = retryAfterSeconds * 1000;
    return ms <= client.retryMaxDelayMs ? ms : undefined;
  }
  const ceiling = Math.min(client.retryMaxDelayMs, client.retryBaseDelayMs * 2 ** attempt);
  return ceiling * (0.5 + Math.random() / 2);
}

/** `Retry-After` in seconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }
  const getter = (headers as { get?: unknown }).get;
  const value =
    typeof getter === 'function'
      ? getter.call(headers, name)
      : (headers as Record<string, unknown>)[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  return Array.isArray(value) ? value.join(',') : String(value);
}
