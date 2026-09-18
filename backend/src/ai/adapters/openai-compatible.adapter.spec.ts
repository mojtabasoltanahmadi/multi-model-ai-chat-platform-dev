import { OpenAiCompatibleAdapter } from './openai-compatible.adapter';
import { ProviderError } from '../provider-errors';
import { sseResponse, errorResponse, abortError } from '../../test/sse';
import type { AiModel } from '../../models/ai-model.entity';

const model = (overrides: Partial<AiModel> = {}): AiModel =>
  ({
    id: 'model-1',
    name: 'GPT Test',
    provider: 'openai-compatible',
    externalModelId: 'gpt-4o-mini',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
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

describe('OpenAiCompatibleAdapter', () => {
  let adapter: OpenAiCompatibleAdapter;
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    adapter = new OpenAiCompatibleAdapter({ get: () => undefined } as any);
  });

  it('streams text deltas from data: lines and stops at [DONE]', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"سلام "}}]}\n\n',
        ': keep-alive comment\n\n',
        'data: {"choices":[{"delta":{"content":"دنیا"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const events = await collect(adapter.streamChat(history, model(), new AbortController().signal));

    expect(events).toEqual([
      { type: 'text', text: 'سلام ' },
      { type: 'text', text: 'دنیا' },
    ]);
  });

  it('extracts token usage from the final chunk when reported', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    const events = await collect(adapter.streamChat(history, model(), new AbortController().signal));

    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 12,
      outputTokens: 34,
    });
  });

  it('ignores malformed JSON lines without crashing the stream', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: not-json\n\n',
        'data: {"choices":[{"delta":{"content":"پاسخ"}}]}\n\n',
      ]),
    );

    const events = await collect(adapter.streamChat(history, model(), new AbortController().signal));
    expect(events).toEqual([{ type: 'text', text: 'پاسخ' }]);
  });

  it('splits one network chunk carrying several SSE lines', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"یک"}}]}\ndata: {"choices":[{"delta":{"content":"دو"}}]}\n\n',
      ]),
    );

    const events = await collect(adapter.streamChat(history, model(), new AbortController().signal));
    expect(events.map((event) => event.text)).toEqual(['یک', 'دو']);
  });

  it('sends the Authorization header, model id and history as OpenAI chat', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));

    await collect(
      adapter.streamChat(
        [{ role: 'user', content: 'سؤال' }, { role: 'assistant', content: 'پاسخ' }, { role: 'user', content: 'ادامه' }],
        model(),
        new AbortController().signal,
      ),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body)).toEqual({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: 'سؤال' },
        { role: 'assistant', content: 'پاسخ' },
        { role: 'user', content: 'ادامه' },
      ],
      stream: true,
    });
  });

  it('falls back to the official OpenAI base URL when none is configured', async () => {
    fetchMock.mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    await collect(adapter.streamChat(history, model({ baseUrl: null }), new AbortController().signal));
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('throws invalid-config when the model has no API key', async () => {
    await expect(
      collect(adapter.streamChat(history, model({ apiKey: null }), new AbortController().signal)),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'invalid-config' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate-limit'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [400, 'invalid-request'],
  ])('maps HTTP %i to kind %s', async (status, kind) => {
    fetchMock.mockResolvedValue(errorResponse(status, '{"error":{"message":"detail"}}'));

    await expect(
      collect(adapter.streamChat(history, model(), new AbortController().signal)),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      kind,
      httpStatus: status,
    });
  });

  it('maps a fetch rejection to unavailable, keeping the cause internal', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.9:443'));

    await expect(
      collect(adapter.streamChat(history, model(), new AbortController().signal)),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'unavailable' });
  });

  it('maps an aborted request to timeout', async () => {
    fetchMock.mockRejectedValue(abortError());

    await expect(
      collect(adapter.streamChat(history, model(), new AbortController().signal)),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'timeout' });
  });
});
