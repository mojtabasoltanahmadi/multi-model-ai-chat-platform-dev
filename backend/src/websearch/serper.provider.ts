import { Injectable, Logger } from '@nestjs/common';
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
 * MVP search backend (https://serper.dev). All Serper specifics live here:
 * endpoint, headers, payload and response shape. Callers only see
 * normalized `WebSearchResult`s or a classified `WebSearchErrorType`.
 *
 * The API key is read from config (`SERPER_API_KEY`) — never hard-coded,
 * never logged, never returned.
 */
@Injectable()
export class SerperWebSearchProvider implements WebSearchProvider {
  readonly name = 'serper';
  private readonly logger = new Logger(SerperWebSearchProvider.name);

  constructor(private readonly configService: ConfigService) {}

  get apiKey(): string {
    return this.configService.get<string>('websearch.serperApiKey') ?? '';
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
      // Almost certainly a missing/invalid key — say so without leaking it.
      this.logger.warn(`Serper request rejected (HTTP ${response.status}).`);
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
