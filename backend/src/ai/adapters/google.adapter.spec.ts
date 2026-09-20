import { GoogleAdapter } from './google.adapter';
import { ProviderError } from '../provider-errors';
import { sseResponse, errorResponse, abortError } from '../../test/sse';
import type { AiModel } from '../../models/ai-model.entity';

const model = (overrides: Partial<AiModel> = {}): AiModel =>
  ({
    id: 'model-1',
    name: 'Gemini Test',
    provider: 'google',
    externalModelId: 'gemini-1.5-flash',
    baseUrl: null,
    apiKey: 'goog-key',
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

describe('GoogleAdapter', () => {
  let adapter: GoogleAdapter;
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    adapter = new GoogleAdapter({ get: () => undefined } as any);
  });

  it('streams text parts and reports the last usageMetadata at the end', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"سلام "}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"دنیا"}]}},{"text":"?"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":8}}\n\n',
        'data: {"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":12,"totalTokenCount":17}}\n\n',
      ]),
    );

    const events = await collect(adapter.streamChat(history, model(), new AbortController().signal));

    expect(events).toEqual([
      { type: 'text', text: 'سلام ' },
      { type: 'text', text: 'دنیا' },
      { type: 'usage', inputTokens: 5, outputTokens: 12 },
    ]);
  });

  it('signals thinking on `thought` parts but never forwards their content (INV-12)', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"استدلال خصوصی","thought":true}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"پاسخ"}]}}]}\n\n',
      ]),
    );

    const events = await collect(adapter.streamChat(history, model(), new AbortController().signal));

    expect(events).toEqual([
      { type: 'status', status: 'thinking' },
      { type: 'text', text: 'پاسخ' },
    ]);
    expect(JSON.stringify(events)).not.toContain('استدلال خصوصی');
  });

  it('maps assistant history to the model role and drops LEADING model turns', async () => {
    fetchMock.mockResolvedValue(sseResponse([]));

    await collect(
      adapter.streamChat(
        [
          { role: 'assistant', content: 'پاسخ پیشین' },
          { role: 'user', content: 'سؤال' },
          { role: 'assistant', content: 'پاسخ' },
          { role: 'user', content: 'ادامه' },
        ],
        model(),
        new AbortController().signal,
      ),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'سؤال' }] },
      { role: 'model', parts: [{ text: 'پاسخ' }] },
      { role: 'user', parts: [{ text: 'ادامه' }] },
    ]);
  });

  it('calls streamGenerateContent with the API key header, never in the URL', async () => {
    fetchMock.mockResolvedValue(sseResponse([]));

    await collect(adapter.streamChat(history, model(), new AbortController().signal));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent',
    );
    expect(url).not.toContain('goog-key');
    expect(init.headers['x-goog-api-key']).toBe('goog-key');
  });

  it('URL-encodes model ids with special characters', async () => {
    fetchMock.mockResolvedValue(sseResponse([]));
    await collect(
      adapter.streamChat(history, model({ externalModelId: 'gemini/a b' }), new AbortController().signal),
    );
    expect(fetchMock.mock.calls[0][0]).toContain('/models/gemini%2Fa%20b:streamGenerateContent');
  });

  it('maps an in-stream error object onto the closed kind set', async () => {
    fetchMock.mockResolvedValue(
      sseResponse(['data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}\n\n']),
    );

    await expect(
      collect(adapter.streamChat(history, model(), new AbortController().signal)),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'rate-limit' });
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
    fetchMock.mockResolvedValue(errorResponse(status, '{"error":{"code":' + status + '}}'));

    await expect(
      collect(adapter.streamChat(history, model(), new AbortController().signal)),
    ).rejects.toMatchObject({ name: 'ProviderError', kind, httpStatus: status });
  });

  it('maps a fetch rejection to unavailable and an abort to timeout', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(
      collect(adapter.streamChat(history, model(), new AbortController().signal)),
    ).rejects.toMatchObject({ kind: 'unavailable' });

    fetchMock.mockRejectedValueOnce(abortError());
    await expect(
      collect(adapter.streamChat(history, model(), new AbortController().signal)),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});
