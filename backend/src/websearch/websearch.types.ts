/**
 * Provider-neutral web search contracts.
 *
 * The chat flow depends ONLY on these types plus `WEB_SEARCH_PROVIDER`
 * (implemented by `SerperWebSearchProvider` for the MVP). Swapping the
 * search backend later means adding another `WebSearchProvider` — the chat
 * service never sees provider-specific payloads.
 */

/** One normalized search hit, safe to persist and to send to the client. */
export interface WebSearchResult {
  title: string;
  url: string;
  /** Host without scheme/path (e.g. `react.dev`) — derived, never trusted input. */
  domain: string;
  snippet: string;
}

/** A source attached to an assistant message (persisted + streamed). */
export interface MessageSource {
  title: string;
  url: string;
  domain: string;
  snippet: string;
}

export interface WebSearchOptions {
  /** Max results to request/return (bounded by server config). */
  maxResults?: number;
  /** Per-request timeout in ms (bounded by server config). */
  timeoutMs?: number;
}

/**
 * Machine-readable search failure classes. Mapped to safe user-facing
 * copy by the caller — the raw provider detail never leaves the backend.
 */
export type WebSearchErrorType =
  | 'disabled'
  | 'misconfigured'
  | 'timeout'
  | 'rate_limited'
  | 'unauthorized'
  | 'network'
  | 'invalid_response'
  | 'provider_error';

/**
 * Outcome of one search attempt. Never throws for provider problems:
 * failures are VALUES so the chat flow can degrade to "answer without web
 * context" instead of crashing the turn.
 */
export type WebSearchOutcome =
  | { ok: true; results: WebSearchResult[] }
  | { ok: false; errorType: WebSearchErrorType };

/**
 * Abstraction every search backend implements. `search` resolves (never
 * rejects) with normalized results or a classified failure.
 */
export interface WebSearchProvider {
  /** Stable backend name for logs/metrics (e.g. `serper`). Never a secret. */
  readonly name: string;
  search(query: string, options?: WebSearchOptions): Promise<WebSearchOutcome>;
}
