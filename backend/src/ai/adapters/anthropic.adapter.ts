import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiModel } from '../../models/ai-model.entity';
import {
  ChatHistoryItem,
  ProviderAdapter,
  ProviderEvent,
  requestSignalWithTimeout,
  sseDataLines,
} from '../provider-adapter';
import { ProviderError, kindForHttpStatus } from '../provider-errors';
import { normalizeTransportError } from './openai-compatible.adapter';

/**
 * The Anthropic Messages API requires an explicit response budget; models
 * must never be configured with a smaller mental budget than this MVP needs.
 */
const ANTHROPIC_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = '2023-06-01';

/** Mid-stream `error` event types → normalized kinds. */
const ANTHROPIC_ERROR_KINDS: Record<string, ProviderError['kind']> = {
  overloaded_error: 'unavailable',
  rate_limit_error: 'rate-limit',
  authentication_error: 'auth',
  permission_error: 'auth',
  invalid_request_error: 'invalid-request',
  api_error: 'unavailable',
  timeout_error: 'timeout',
};

/**
 * Anthropic Claude adapter — native Messages API with SSE streaming
 * (`https://docs.anthropic.com/en/api/messages`).
 *
 * The private `thinking` channel (extended thinking) is deliberately NOT
 * forwarded: adapters never surface provider reasoning streams (INV-12) —
 * only `text_delta` becomes a normalized `text` event.
 */
@Injectable()
export class AnthropicAdapter implements ProviderAdapter {
  private readonly logger = new Logger(AnthropicAdapter.name);
  private readonly requestTimeoutMs: number;

  constructor(configService: ConfigService) {
    this.requestTimeoutMs =
      configService.get<number>('ai.requestTimeoutMs') ?? 60000;
  }

  async *streamChat(
    history: ChatHistoryItem[],
    model: AiModel,
    signal: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    if (!model.apiKey) {
      throw new ProviderError(
        'invalid-config',
        null,
        `Model "${model.name}" has no API key configured.`,
      );
    }
    const baseUrl = (model.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    const { signal: requestSignal, dispose } = requestSignalWithTimeout(
      signal,
      this.requestTimeoutMs,
    );

    try {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': model.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: model.externalModelId,
            messages: history,
            max_tokens: ANTHROPIC_MAX_TOKENS,
            stream: true,
          }),
          signal: requestSignal,
        });
      } catch (error) {
        throw normalizeTransportError(error, model.name);
      }

      if (!response.ok || !response.body) {
        const detail = await safeReadBody(response);
        this.logger.error(
          `Anthropic returned ${response.status} for model ${model.name}: ${detail}`,
        );
        throw new ProviderError(
          kindForHttpStatus(response.status),
          response.status,
          `Anthropic error (HTTP ${response.status}).`,
        );
      }

      // input_tokens arrives on `message_start`, output_tokens on
      // `message_delta` (final). One cumulative `usage` event is yielded when
      // the stream ends.
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;

      for await (const data of sseDataLines(response.body)) {
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // keep-alive / malformed line — never crash the stream
        }

        if (parsed?.type === 'error') {
          const kind = ANTHROPIC_ERROR_KINDS[parsed?.error?.type] ?? 'unknown';
          throw new ProviderError(
            kind,
            null,
            `Anthropic stream error (${parsed?.error?.type ?? 'unknown'}).`,
          );
        }

        if (parsed?.type === 'message_start') {
          inputTokens = Number(parsed?.message?.usage?.input_tokens ?? 0);
        } else if (parsed?.type === 'message_delta') {
          outputTokens = Number(parsed?.usage?.output_tokens ?? 0);
        } else if (parsed?.type === 'content_block_delta') {
          // Only the public text channel is forwarded; thinking_delta and any
          // other channel type are silently dropped (INV-12).
          if (parsed?.delta?.type === 'text_delta' && parsed.delta.text) {
            yield { type: 'text', text: parsed.delta.text };
          }
        }
      }

      if (inputTokens !== null || outputTokens !== null) {
        yield {
          type: 'usage',
          inputTokens: inputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
        };
      }
    } catch (error) {
      // An abort that lands mid-stream (shutdown) surfaces as a bare
      // AbortError — normalize it like every other transport failure.
      if (error instanceof Error && error.name === 'AbortError') {
        throw normalizeTransportError(error, model.name);
      }
      throw error;
    } finally {
      dispose();
    }
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<unreadable>';
  }
}
