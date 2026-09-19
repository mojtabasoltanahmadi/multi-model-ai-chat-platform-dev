import { AiModel } from '../models/ai-model.entity';

/**
 * The provider abstraction contracts (day-7-8 contract §22.3).
 *
 * Every provider integration implements `ProviderAdapter` (Adapter pattern);
 * `AiProviderService` selects the strategy from `model.provider` (Strategy
 * pattern). Adapters own provider-specific request building, SSE parsing and
 * usage extraction, and normalize every failure to a `ProviderError` — they
 * never leak raw provider payloads or errors to callers.
 */

export interface ChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Normalized provider stream events. `AiProviderService.streamChat` yields
 * these; the generation loop appends `text` events to the message content and
 * ignores what it does not know (new event types are additive).
 */
export type ProviderEvent =
  | { type: 'text'; text: string } // append to the assistant message content
  | { type: 'status'; status: 'thinking' } // optional, pre-first-token narration
  | { type: 'usage'; inputTokens: number; outputTokens: number }; // 0–1×, typically last

export interface ProviderAdapter {
  /**
   * Streams one chat completion for the given history and model row.
   * MUST honor `signal` (the orchestrator owns the timeout + shutdown abort)
   * and MUST throw `ProviderError` (never bare errors) on failure.
   */
  streamChat(
    history: ChatHistoryItem[],
    model: AiModel,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent>;
}

/**
 * Shared SSE line reader: splits a byte stream into `data:` payload strings,
 * skipping comments/keep-alives and emitting one entry per `data:` line.
 * Returns non-null payload strings, trimmed; `[DONE]` sentinels stay in.
 */
export async function* sseDataLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, separatorIndex).trim();
        buffer = buffer.slice(separatorIndex + 1);
        if (!line.startsWith('data:')) continue;
        yield line.slice('data:'.length).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Derives the abort signal for one provider request: aborts on the
 * orchestrator's `external` signal (shutdown) or after `timeoutMs`
 * (`AI_REQUEST_TIMEOUT_MS`, default 60 s — matching the historical behavior,
 * the budget covers request establishment, not the whole stream).
 * Callers MUST invoke `dispose()` once the response head arrived (or on
 * failure) so the timer never outlives the request.
 */
export function requestSignalWithTimeout(
  external: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (external.aborted) controller.abort();
  else external.addEventListener('abort', onExternalAbort);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      external.removeEventListener('abort', onExternalAbort);
    },
  };
}
