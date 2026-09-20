/**
 * Normalized provider failure taxonomy (day-7-8 contract §22.4).
 *
 * Adapters map every provider-specific failure (HTTP status, network error,
 * abort) onto exactly one of these kinds. The generation loop and any future
 * fallback policy branch on `kind` only — never on message text or HTTP codes.
 * `message` carries internal detail and is NEVER sent to clients; the chat
 * turn maps kinds onto the two safe Persian failure sentences.
 */
export type ProviderErrorKind =
  | 'timeout' // the request exceeded AI_REQUEST_TIMEOUT_MS (retryable)
  | 'rate-limit' // provider answered 429 (retryable)
  | 'unavailable' // provider 5xx / connection refused / network drop (retryable)
  | 'auth' // provider rejected the API key (401/403) — fail fast
  | 'invalid-request' // provider rejected the request body (4xx) — fail fast
  | 'invalid-config' // model misconfigured on OUR side (missing key, bad URL, unknown provider) — fail fast
  | 'cancelled' // the client aborted this turn (Stop button) — NOT an error, never retried
  | 'unknown'; // anything unclassifiable — fail fast

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    /** Provider HTTP status when known; null for timeouts and network errors. */
    public readonly httpStatus: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Standard HTTP status → ProviderErrorKind mapping shared by all adapters. */
export function kindForHttpStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'unavailable';
  return 'invalid-request';
}
