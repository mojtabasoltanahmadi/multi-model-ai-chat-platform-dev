import { AnthropicAdapter } from './anthropic.adapter';
import { ProviderError } from '../provider-errors';
import { sseResponse, errorResponse, abortError } from '../../test/sse';
import type { AiModel } from '../../models/ai-model.entity';

const model = (overrides: Partial<AiModel> = {}): AiModel =>
  ({
    id: 'model-1',
    name: 'Claude Test',
    provider: 'anthropic',
    externalModelId: 'claude-3-5-sonnet-latest',
    baseUrl: null,
    apiKey: 'sk-ant-test',
    isActive: true,
    isFree: true,
    isDefault: false,
    capabilities: [],
    createdAt: new Date(),
    ...overrides,
  }) as AiModel;

const history = [{ role: 'user' as const, content: 'سلام' }];

async function collect(generator: AsyncGenerator<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe('AnthropicAdapter', () => {
  let adapter: AnthropicAdapter;
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    adapter = new AnthropicAdapter({ get: () => undefined } as any);
  });

  it('streams text_delta events as normalized text and reports usage once at the end', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"سلام "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"دنیا"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":11}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );

    const events = await collect(adapter.streamChat(history, model(), new AbortController().signal));

    expect(events).toEqual([
      { type: 'text', text: 'سلام ' },
      { type: 'text', text: 'دنیا' },
      { type: 'usage', inputTokens: 7, outputTokens: 11 },
    ]);
  });

  it('NEVER forwards thinking_delta — no reasoning content leaves the adapter (INV-12)', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"private chain of thought"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"پاسخ عمومی"}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"signature_delta","signature":"sig"}}\n\n',
      ]),
    );

    const events = await collect(adapter.streamChat(history, model(), new AbortController().signal));

    expect(events).toEqual([{ type: 'text', text: 'پاسخ عمومی' }]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('chain of thought');
    expect(serialized).not.toContain('thinking');
  });

  it('maps mid-stream error events onto the closed kind set', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ]),
    );

    await expect(
      collect(adapter.streamChat(history, model(), new AbortController().signal)),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'unavailable' });
  });

  it('maps a rate-limit stream error to rate-limit', async () => {
    fetchMock.mockResolvedValue(
      sseResponse(['data: {"type":"error","error":{"type":"rate_limit_error"}}\n\n']),
    );

    await expect(
      collect(adapter.streamChat(history, model(), new AbortController().signal)),
    ).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('sends the x-api-key header, anthropic-version and max_tokens', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: {"type":"message_stop"}\n\n']));

    await collect(adapter.streamChat(history, model(), new AbortController().signal));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant-test');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 4096,
      stream: true,
    });
    expect(body.messages).toEqual(history);
  });

  it('honors a custom base URL', async () => {
    fetchMock.mockResolvedValue(sseResponse([]));
    await collect(
      adapter.streamChat(history, model({ baseUrl: 'https://proxy.example.com/anthropic/' }), new AbortController().signal),
    );
    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.example.com/anthropic/messages');
  });

  it('throws invalid-config when the model has no API key', async () => {
    await expect(
      collect(adapter.streamChat(history, model({ apiKey: null }), new AbortController().signal)),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'invalid-config' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'auth'],
    [429, 'rate-limit'],
    [500, 'unavailable'],
    [400, 'invalid-request'],
  ])('maps HTTP %i to kind %s', async (status, kind) => {
    fetchMock.mockResolvedValue(errorResponse(status, '{"error":{"type":"api_error"}}'));

    await expect(
      collect(adapter.streamChat(history, model(), new AbortController().signal)),
    ).rejects.toMatchObject({ name: 'ProviderError', kind, httpStatus: status });
  });

  it('maps a fetch rejection to unavailable and an abort to timeout', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(
      collect(adapter.streamChat(history, model(), new AbortController().signal)),
    ).rejects.toMatchObject({ kind: 'unavailable' });

    fetchMock.mockRejectedValueOnce(abortError());
    await expect(
      collect(adapter.streamChat(history, model(), new AbortController().signal)),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});
