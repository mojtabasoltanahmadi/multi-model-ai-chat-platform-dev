import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SerperWebSearchProvider } from './serper.provider';
import { buildWebSearchPrompt } from './web-search-context';
import type {
  MessageSource,
  WebSearchErrorType,
  WebSearchOutcome,
} from './websearch.types';

/**
 * Safe user-facing copy per failure class. No secrets, no provider payloads,
 * no stack traces — the raw detail stays in server logs.
 */
export const WEB_SEARCH_WARNING_BY_ERROR: Record<WebSearchErrorType, string> = {
  disabled: 'جستجوی وب غیرفعال است. پاسخ بدون اطلاعات وب تولید شد.',
  misconfigured: 'جستجوی وب پیکربندی نشده است. پاسخ بدون اطلاعات وب تولید شد.',
  timeout: 'جستجوی وب بیش از حد طول کشید. پاسخ بدون اطلاعات وب تولید شد.',
  rate_limited: 'سرویس جستجو موقتاً محدود شده است. پاسخ بدون اطلاعات وب تولید شد.',
  unauthorized: 'سرویس جستجو در دسترس نیست. پاسخ بدون اطلاعات وب تولید شد.',
  network: 'ارتباط با سرویس جستجو برقرار نشد. پاسخ بدون اطلاعات وب تولید شد.',
  invalid_response: 'پاسخ سرویس جستجو نامعتبر بود. پاسخ بدون اطلاعات وب تولید شد.',
  provider_error: 'سرویس جستجو موقتاً در دسترس نیست. پاسخ بدون اطلاعات وب تولید شد.',
};

export interface WebSearchRun {
  /** Sources to persist on the assistant row (empty when search degraded). */
  sources: MessageSource[];
  /** Search block to prepend to the user's prompt ('' when degraded). */
  contextBlock: string;
  /**
   * Set when the answer was produced WITHOUT web context — the client
   * surfaces it once ("⚠️ …") instead of failing the turn.
   */
  warning: string | null;
}

/**
 * Orchestrates one opt-in web search for a chat turn. Depends on the
 * provider ABSTRACTION (`SerperWebSearchProvider` behind it) — never on
 * Serper payloads. Degradation is a return value, never an exception:
 * any provider failure yields `{ sources: [], contextBlock: '', warning }`
 * so the turn continues as a normal chat turn.
 *
 * Cost-control rails (all config-driven): global kill-switch, capped query
 * length, capped result count, capped context size, per-request timeout,
 * and search runs only when the turn explicitly opts in (the chat service
 * never calls this for history loads or plain turns).
 */
@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);

  constructor(
    private readonly provider: SerperWebSearchProvider,
    private readonly configService: ConfigService,
  ) {}

  /** Global kill-switch (`WEB_SEARCH_ENABLED`). */
  // isEnabled(): boolean {
  //   return this.configService.get<boolean>('websearch.enabled') ?? false;
  // }
  isEnabled(): boolean {
  const enabled = this.configService.get<boolean>('websearch.enabled');

  console.log('WEB SEARCH ENABLED:', enabled);

  return enabled ?? false;
}

  /** True when a search may actually run (enabled + provider key present). */
  isAvailable(): boolean {
    return this.isEnabled() && this.provider.apiKey.length > 0;
  }

  async runForTurn(rawQuery: string): Promise<WebSearchRun> {
    const empty: WebSearchRun = { sources: [], contextBlock: '', warning: null };
    if (!this.isEnabled()) return { ...empty, warning: WEB_SEARCH_WARNING_BY_ERROR.disabled };

    const maxQueryLength =
      this.configService.get<number>('websearch.maxQueryLength') ?? 500;
    const query = rawQuery.trim().slice(0, Math.max(maxQueryLength, 1));
    if (!query) return empty;

    if (!this.isAvailable()) {
      this.logger.warn('Web search requested but no provider key is configured.');
      return { ...empty, warning: WEB_SEARCH_WARNING_BY_ERROR.misconfigured };
    }

    const maxResults = this.configService.get<number>('websearch.maxResults') ?? 5;
    const timeoutMs = this.configService.get<number>('websearch.timeoutMs') ?? 5000;
    const maxContextChars =
      this.configService.get<number>('websearch.maxContextChars') ?? 6000;

    const startedAt = Date.now();
    const outcome: WebSearchOutcome = await this.provider.search(query, {
      maxResults,
      timeoutMs,
    });
    const durationMs = Date.now() - startedAt;

    if (!outcome.ok) {
      // No query text, no secrets — only class + counts.
      this.logger.warn(
        `web_search_failed provider=${this.provider.name} errorType=${outcome.errorType} durationMs=${durationMs}`,
      );
      return { ...empty, warning: WEB_SEARCH_WARNING_BY_ERROR[outcome.errorType] };
    }

    this.logger.log(
      `web_search_completed provider=${this.provider.name} results=${outcome.results.length} durationMs=${durationMs}`,
    );

    if (outcome.results.length === 0) {
      return { ...empty, warning: 'نتیجه‌ای در وب پیدا نشد. پاسخ بدون اطلاعات وب تولید شد.' };
    }

    const sources: MessageSource[] = outcome.results.map((result) => ({
      title: result.title,
      url: result.url,
      domain: result.domain,
      snippet: result.snippet,
    }));
    // NOTE: buildWebSearchPrompt's second arg is normally the user question;
    // here we pass '' and let the caller prepend the block to the real
    // prompt (file context + question) — one composition point, no
    // duplication of the user's text.
    const contextBlock = buildWebSearchPrompt(outcome.results, '', maxContextChars).trimEnd();
    return { sources, contextBlock, warning: null };
  }
}
