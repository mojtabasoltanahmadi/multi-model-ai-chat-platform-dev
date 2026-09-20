import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  WebSearchOptions,
  WebSearchOutcome,
  WebSearchProvider,
  WebSearchResult,
} from './websearch.types';
import { extractDomain, normalizeUrlKey } from './url-safety';

/** Serper organic result shape (only the fields we consume). */
interface SerperOrganicItem {
  title?: unknown;
  link?: unknown;
  snippet?: unknown;
}

interface SerperResponse {
  organic?: unknown;
}

export const SERPER_ENDPOINT = 'https://google.serper.dev/search';
const MAX_SNIPPET_CHARS = 500;

/**
 * Normalizes a raw SERPER_API_KEY value from the environment: trims
 * surrounding whitespace (a stray trailing space/newline/CRLF from hand-edited
 * env files would silently corrupt the `X-API-KEY` header) and strips ONE
 * matching pair of surrounding quotes (no real key starts AND ends with a
 * quote — that is shell/.env quoting left in the value).
 */
export function normalizeApiKey(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/**
 * Safe, loggable key fingerprint: a short prefix + `*****` + the length.
 * Never returns the full value — enough to spot truncation/quoting problems,
 * never enough to leak the secret (keys are 40 chars; ≤8-char values are
 * masked entirely).
 */
export function maskApiKey(key: string): string {
  if (!key) return '<empty>';
  if (key.length <= 8) return `***** (len=${key.length})`;
  return `${key.slice(0, 5)}***** (len=${key.length})`;
}

/**
 * MVP search backend (https://serper.dev). All Serper specifics live here:
 * endpoint, headers, payload and response shape. Callers only see
 * normalized `WebSearchResult`s or a classified `WebSearchErrorType`.
 *
 * The API key is read from config (`SERPER_API_KEY`) — never hard-coded,
 * never logged, never returned.
 */
@Injectable()
export class SerperWebSearchProvider implements WebSearchProvider, OnModuleInit {
  readonly name = 'serper';
  private readonly logger = new Logger(SerperWebSearchProvider.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Read per request (not constructor-cached): tests can re-stub config, and
   * the value passes through `normalizeApiKey` so a mangled env value can
   * never corrupt the auth header.
   */
  get apiKey(): string {
    return normalizeApiKey(
      this.configService.get<string>('websearch.serperApiKey') ?? '',
    );
  }

  /**
   * Boot-time presence check with a MASKED fingerprint only. A 403 later in
   * the logs can then be attributed to a loaded-vs-missing key without ever
   * logging the secret itself.
   */
  onModuleInit(): void {
    if (!this.apiKey) {
      this.logger.warn('SERPER KEY MISSING — web search turns will degrade (misconfigured).');
      return;
    }
    this.logger.log(`SERPER KEY LOADED: ${maskApiKey(this.apiKey)}`);
  }

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchOutcome> {
    if (!this.apiKey) return { ok: false, errorType: 'misconfigured' };

    const maxResults = Math.max(
      1,
      Math.min(
        options?.maxResults ?? 5,
        this.configService.get<number>('websearch.maxResults') ?? 5,
      ),
    );
    const timeoutMs = Math.max(
      1000,
      Math.min(
        options?.timeoutMs ?? 5000,
        this.configService.get<number>('websearch.timeoutMs') ?? 5000,
      ),
    );

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(SERPER_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-KEY': this.apiKey,
        },
        body: JSON.stringify({ q: query, num: maxResults }),
        signal: controller.signal,
      });
    } catch (error) {
      // No query/secret detail in logs — only the failure class.
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, errorType: 'timeout' };
      }
      this.logger.warn(`Serper request failed (network): ${errorName(error)}`);
      return { ok: false, errorType: 'network' };
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) return { ok: false, errorType: 'rate_limited' };
    if (response.status === 401 || response.status === 403) {
      // Serper's OWN auth failures are JSON bodies. A 401/403 with a
      // non-JSON (HTML) page comes from the GOOGLE FRONT END — the request
      // was blocked on the network edge (client IP) BEFORE Serper's
      // application ever evaluated the key; a new key cannot fix that, the
      // egress route (VPN/proxy) must. Log the masked fingerprint so the
      // loaded-vs-missing question is answerable without leaking the secret.
      const contentType = response.headers.get('content-type') ?? '';
      const blockedBeforeSerper = !contentType.includes('json');
      this.logger.warn(
        `Serper request rejected (HTTP ${response.status}) key=${maskApiKey(this.apiKey)}` +
          (blockedBeforeSerper
            ? ' — non-JSON error page: request blocked BEFORE Serper (network/IP edge block); the API key was never evaluated.'
            : ' — Serper rejected the key (invalid/expired/no quota).'),
      );
      return { ok: false, errorType: 'unauthorized' };
    }
    if (!response.ok) {
      this.logger.warn(`Serper request failed (HTTP ${response.status}).`);
      return { ok: false, errorType: 'provider_error' };
    }

    let json: SerperResponse;
    try {
      json = (await response.json()) as SerperResponse;
    } catch {
      return { ok: false, errorType: 'invalid_response' };
    }
    if (!json || typeof json !== 'object' || !Array.isArray(json.organic)) {
      return { ok: false, errorType: 'invalid_response' };
    }

    return { ok: true, results: normalizeOrganic(json.organic, maxResults) };
  }
}

/**
 * Normalizes raw organic hits: drops unsafe/missing URLs, trims text,
 * de-duplicates by canonical URL. Pure — unit-tested without network.
 */
export function normalizeOrganic(items: unknown, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(items)) return results;

  for (const item of items) {
    if (results.length >= maxResults) break;
    if (!item || typeof item !== 'object') continue;
    const { title, link, snippet } = item as SerperOrganicItem;
    if (typeof link !== 'string') continue;
    const key = normalizeUrlKey(link);
    const domain = extractDomain(link);
    if (!key || !domain || seen.has(key)) continue;
    seen.add(key);
    results.push({
      title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 200) : domain,
      url: link.trim(),
      domain,
      snippet:
        typeof snippet === 'string' && snippet.trim()
          ? snippet.trim().slice(0, MAX_SNIPPET_CHARS)
          : '',
    });
  }
  return results;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
