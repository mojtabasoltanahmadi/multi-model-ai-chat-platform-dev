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

/**
 * Any OpenAI-compatible streaming /chat/completions API (OpenAI, Azure-style
 * gateways, local vLLM/ollama endpoints…). Extracted from the former
 * `AiProviderService` switch arm; this adapter owns only request building,
 * SSE parsing and error normalization.
 */
@Injectable()
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  private readonly logger = new Logger(OpenAiCompatibleAdapter.name);
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
    const baseUrl = (model.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const { signal: requestSignal, dispose } = requestSignalWithTimeout(
      signal,
      this.requestTimeoutMs,
    );

    try {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${model.apiKey}`,
          },
          body: JSON.stringify({
            model: model.externalModelId,
            messages: history,
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
          `AI provider returned ${response.status} for model ${model.name}: ${detail}`,
        );
        throw new ProviderError(
          kindForHttpStatus(response.status),
          response.status,
          `AI provider error (HTTP ${response.status}).`,
        );
      }

      // Parse the SSE stream from the provider: lines of "data: {...}".
      // Token usage is extracted when the provider reports it on the final
      // chunk; we deliberately do NOT send `stream_options.include_usage` —
      // not every OpenAI-compatible endpoint tolerates unknown fields.
      for await (const data of sseDataLines(response.body)) {
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const choice = parsed?.choices?.[0];
          // A reasoning channel (e.g. DeepSeek-style `reasoning_content`)
          // signals the thinking phase — as a STATUS only; its content is
          // never forwarded (INV-12, day-7-8 §10).
          if (
            typeof choice?.delta?.reasoning_content === 'string' &&
            choice.delta.reasoning_content
          ) {
            yield { type: 'status', status: 'thinking' };
          }
          const delta: string | undefined = choice?.delta?.content;
          if (delta) yield { type: 'text', text: delta };
          const usage = parsed?.usage;
          if (usage) {
            yield {
              type: 'usage',
              inputTokens: Number(usage.prompt_tokens ?? 0),
              outputTokens: Number(usage.completion_tokens ?? 0),
            };
          }
        } catch {
          // Ignore malformed keep-alive lines; do not crash the stream.
        }
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

/** fetch abort (our timeout/shutdown) → timeout; everything else → unavailable. */
export function normalizeTransportError(error: unknown, modelName: string): ProviderError {
  if (error instanceof Error && error.name === 'AbortError') {
    return new ProviderError('timeout', null, `AI request for model ${modelName} timed out.`);
  }
  return new ProviderError(
    'unavailable',
    null,
    `Could not reach AI provider for model ${modelName}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '<unreadable>';
  }
}
