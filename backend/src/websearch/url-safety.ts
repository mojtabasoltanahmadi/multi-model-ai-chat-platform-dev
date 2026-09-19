/**
 * URL safety for web search results.
 *
 * Search output is untrusted external data: only `http:`/`https:` URLs are
 * ever persisted or rendered as links (`javascript:`, `data:`, … are
 * dropped). The domain is always re-derived from the parsed URL — never
 * taken from provider payloads.
 */

/** True when the value is an absolute http(s) URL and nothing else. */
export function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/** Host of a safe URL (`example.com`), or null when the URL is unsafe. */
export function extractDomain(url: string): string | null {
  if (!isSafeHttpUrl(url)) return null;
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Canonical key for de-duplication: scheme + lowercase host + path without
 * a trailing slash (query/fragment dropped — trackers must not fork entries).
 * Returns null for unsafe URLs so callers can drop them in one step.
 */
export function normalizeUrlKey(url: string): string | null {
  if (!isSafeHttpUrl(url)) return null;
  try {
    const parsed = new URL(url.trim());
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${path}`;
  } catch {
    return null;
  }
}
