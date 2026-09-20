import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { AiModel, AiProviderKind } from '../models/ai-model.entity';
import { ChatHistoryItem, ProviderAdapter, ProviderEvent } from './provider-adapter';
import { ProviderError } from './provider-errors';
import { MockAdapter } from './adapters/mock.adapter';
import { OpenAiCompatibleAdapter } from './adapters/openai-compatible.adapter';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { GoogleAdapter } from './adapters/google.adapter';

/**
 * Provider orchestrator (Strategy pattern): selects the `ProviderAdapter`
 * (Adapter pattern) registered for `model.provider` and forwards the stream.
 *
 * This class owns everything cross-provider — the per-request abort/timeout
 * (`AI_REQUEST_TIMEOUT_MS`, default 60 s), shutdown cleanup and the
 * unknown-provider guard — while each adapter owns only its wire format.
 * Adding a provider means adding an adapter class + registering it here and
 * in `AiProviderKind`; nothing else changes.
 */
@Injectable()
export class AiProviderService implements OnModuleDestroy {
  private readonly logger = new Logger(AiProviderService.name);
  private readonly adapters: ReadonlyMap<AiProviderKind, ProviderAdapter>;
  private readonly activeControllers = new Set<AbortController>();

  constructor(
    mockAdapter: MockAdapter,
    openAiCompatibleAdapter: OpenAiCompatibleAdapter,
    anthropicAdapter: AnthropicAdapter,
    googleAdapter: GoogleAdapter,
  ) {
    this.adapters = new Map<AiProviderKind, ProviderAdapter>([
      ['mock', mockAdapter],
      ['openai-compatible', openAiCompatibleAdapter],
      ['anthropic', anthropicAdapter],
      ['google', googleAdapter],
    ]);
  }

  async *streamChat(
    history: ChatHistoryItem[],
    model: AiModel,
    externalSignal?: AbortSignal,
  ): AsyncGenerator<ProviderEvent> {
    const adapter = this.adapters.get(model.provider);
    if (!adapter) {
      // Unreachable unless a bad provider value got into the database —
      // fail fast as a configuration problem, not a provider outage.
      throw new ProviderError(
        'invalid-config',
        null,
        `Unknown AI provider: ${model.provider}`,
      );
    }

    const controller = new AbortController();
    this.activeControllers.add(controller);
    // The caller (generation loop) may cancel one turn: forward its abort to
    // the adapter's signal. Shutdown aborts the same set of controllers below,
    // but only a caller abort reclassifies the normalized failure below — a
    // shutdown or adapter timeout must still surface as 'timeout', never as
    // user cancellation.
    let callerAborted = false;
    const onCallerAbort = () => {
      callerAborted = true;
      controller.abort();
    };
    if (externalSignal) {
      if (externalSignal.aborted) onCallerAbort();
      else externalSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    try {
      yield* adapter.streamChat(history, model, controller.signal);
    } catch (error) {
      // Adapters normalize every abort to ProviderError('timeout') (they
      // cannot distinguish who aborted). When OUR caller aborted, this was
      // a user cancellation — reclassify so the generation loop neither
      // marks the row failed nor routes it into the fallback path.
      if (
        callerAborted &&
        error instanceof ProviderError &&
        error.kind === 'timeout'
      ) {
        throw new ProviderError(
          'cancelled',
          null,
          'Generation cancelled by the client.',
        );
      }
      throw error;
    } finally {
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onCallerAbort);
      }
      this.activeControllers.delete(controller);
    }
  }

  onModuleDestroy() {
    // Release in-flight provider calls on shutdown.
    for (const controller of this.activeControllers) controller.abort();
  }
}
