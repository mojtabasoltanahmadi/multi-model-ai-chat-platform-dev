/**
 * URL safety for rendering external sources.
 *
 * Search results are untrusted data: only absolute http(s) URLs ever become
 * links (`javascript:`, `data:`, … are rejected). Mirrors the backend guard
 * (`backend/src/websearch/url-safety.ts`) so unsafe rows are dropped on both
 * sides even if one side ever regresses.
 */

/** True when the value is an absolute http(s) URL and nothing else. */
export function isSafeExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Host of a safe URL (`example.com`), or the raw fallback for display. */
export function safeDomainOf(url: string, fallback: string): string {
  try {
    if (!isSafeExternalUrl(url)) return fallback;
    return new URL(url.trim()).hostname.toLowerCase() || fallback;
  } catch {
    return fallback;
  }
}
