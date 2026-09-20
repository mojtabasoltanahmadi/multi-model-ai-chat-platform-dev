import { AiProviderService } from './ai-provider.service';
import { ChatHistoryItem, ProviderAdapter, ProviderEvent } from './provider-adapter';
import { ProviderError } from './provider-errors';
import { MockAdapter } from './adapters/mock.adapter';
import type { AiModel } from '../models/ai-model.entity';

const model = (provider: AiModel['provider']): AiModel =>
  ({ id: 'm1', name: 'M', provider, externalModelId: 'x', baseUrl: null, apiKey: null }) as AiModel;

const history: ChatHistoryItem[] = [{ role: 'user', content: 'سلام' }];

/** A fake adapter that records the signal it received and yields one text. */
function recordingAdapter(label: string): ProviderAdapter & { calls: number } {
  return {
    calls: 0,
    async *streamChat(
      _history: ChatHistoryItem[],
      _model: AiModel,
      signal: AbortSignal,
    ): AsyncGenerator<ProviderEvent> {
      this.calls++;
      expect(signal).toBeInstanceOf(AbortSignal);
      yield { type: 'text', text: label };
    },
  } as never;
}

async function collect(generator: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe('AiProviderService — strategy selection', () => {
  it('routes each provider kind to its registered adapter (Strategy pattern)', async () => {
    const mock = recordingAdapter('mock');
    const openai = recordingAdapter('openai');
    const anthropic = recordingAdapter('anthropic');
    const google = recordingAdapter('google');
    const service = new AiProviderService(
      mock as never,
      openai as never,
      anthropic as never,
      google as never,
    );

    expect((await collect(service.streamChat(history, model('mock'))))[0]).toMatchObject({
      type: 'text',
      text: 'mock',
    });
    expect((await collect(service.streamChat(history, model('openai-compatible'))))[0]).toMatchObject({
      text: 'openai',
    });
    expect((await collect(service.streamChat(history, model('anthropic'))))[0]).toMatchObject({
      text: 'anthropic',
    });
    expect((await collect(service.streamChat(history, model('google'))))[0]).toMatchObject({
      text: 'google',
    });

    expect(mock.calls).toBe(1);
    expect(openai.calls).toBe(1);
    expect(anthropic.calls).toBe(1);
    expect(google.calls).toBe(1);
  });

  it('throws ProviderError invalid-config for an unknown provider kind', async () => {
    const service = new AiProviderService(
      {} as never, {} as never, {} as never, {} as never,
    );

    await expect(
      collect(service.streamChat(history, model('mystery-provider' as AiModel['provider']))),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'invalid-config' });
  });

  it('aborts in-flight adapters on module shutdown', async () => {
    const hanging: ProviderAdapter = {
      async *streamChat(_history, _model, signal): AsyncGenerator<ProviderEvent> {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      },
    };
    const service = new AiProviderService(
      hanging as never, hanging as never, hanging as never, hanging as never,
    );

    const stream = service.streamChat(history, model('mock'));
    const pending = stream.next();
    // Give the generator a tick to reach the hanging await.
    await new Promise((resolve) => setTimeout(resolve, 10));
    service.onModuleDestroy();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('forwards a completed stream without aborting it', async () => {
    // The constructor params are concrete adapter classes; the same mock
    // adapter class satisfies every slot.
    const mock = new MockAdapter();
    const service = new AiProviderService(
      mock as never, mock as never, mock as never, mock as never,
    );

    const events = await collect(service.streamChat(history, model('mock')));
    expect(events.length).toBeGreaterThan(0);
    // The mock is pure text: the orchestrator narrates the phases itself.
    expect(events.every((event) => event.type === 'text')).toBe(true);
    // The canned Persian response proves the real mock adapter is exercised.
    expect(events.map((event) => (event as { text: string }).text).join('')).toContain('ماک');
  });

  it('normalizes a bare adapter crash into the caller-visible contract', async () => {
    const exploding: ProviderAdapter = {
      async *streamChat(): AsyncGenerator<ProviderEvent> {
        throw new ProviderError('auth', 401, 'bad upstream key');
      },
    };
    const service = new AiProviderService(
      exploding as never, exploding as never, exploding as never, exploding as never,
    );

    await expect(
      collect(service.streamChat(history, model('google'))),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'auth', httpStatus: 401 });
  });
});
