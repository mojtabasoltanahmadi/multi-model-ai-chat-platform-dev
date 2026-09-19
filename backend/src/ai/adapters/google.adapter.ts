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
 * Google Gemini adapter — `streamGenerateContent` with SSE
 * (`https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent`).
 *
 * Wire format notes:
 * - Gemini roles are `user` / `model`; our `assistant` history role maps to
 *   `model`, and leading `model` turns are dropped (the API requires the
 *   first content to be user-turned).
 * - Text arrives as `candidates[0].content.parts[*].text`.
 * - `usageMetadata` rides the final chunk(s); the last value seen wins.
 * - The API key is sent via the `x-goog-api-key` header, never the URL.
 */
@Injectable()
export class GoogleAdapter implements ProviderAdapter {
  private readonly logger = new Logger(GoogleAdapter.name);
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
    const baseUrl = (
      model.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/+$/, '');
    const { signal: requestSignal, dispose } = requestSignalWithTimeout(
      signal,
      this.requestTimeoutMs,
    );

    try {
      // The API requires the first content to be user-turned; drop leading
      // model turns instead of failing the request.
      const contents: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
      for (const item of history) {
        const role = item.role === 'assistant' ? 'model' : 'user';
        if (contents.length === 0 && role === 'model') continue;
        contents.push({ role, parts: [{ text: item.content }] });
      }

      let response: Response;
      try {
        response = await fetch(
          `${baseUrl}/models/${encodeURIComponent(model.externalModelId)}:streamGenerateContent`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': model.apiKey,
            },
            body: JSON.stringify({ contents }),
            signal: requestSignal,
          },
        );
      } catch (error) {
        throw normalizeTransportError(error, model.name);
      }

      if (!response.ok || !response.body) {
        const detail = await safeReadBody(response);
        this.logger.error(
          `Google returned ${response.status} for model ${model.name}: ${detail}`,
        );
        throw new ProviderError(
          kindForHttpStatus(response.status),
          response.status,
          `Google error (HTTP ${response.status}).`,
        );
      }

      let lastUsage: { inputTokens: number; outputTokens: number } | null = null;
      for await (const data of sseDataLines(response.body)) {
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue; // keep-alive / malformed line — never crash the stream
        }

        if (parsed?.error) {
          throw new ProviderError(
            kindForHttpStatus(Number(parsed.error.code ?? 0) || 500),
            Number(parsed.error.code ?? 0) || null,
            `Google stream error (${parsed.error.status ?? 'unknown'}).`,
          );
        }

        const parts = parsed?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (typeof part?.text === 'string' && part.text) {
              yield { type: 'text', text: part.text };
            }
          }
        }
        const usage = parsed?.usageMetadata;
        if (usage) {
          lastUsage = {
            inputTokens: Number(usage.promptTokenCount ?? 0),
            outputTokens: Number(usage.candidatesTokenCount ?? 0),
          };
        }
      }

      if (lastUsage) yield { type: 'usage', ...lastUsage };
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
