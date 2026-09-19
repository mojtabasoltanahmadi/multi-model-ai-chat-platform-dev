import { ConfigService } from '@nestjs/config';
import { normalizeOrganic, SerperWebSearchProvider } from './serper.provider';

const configWith = (values: Record<string, unknown>) =>
  ({ get: (key: string) => values[key] }) as ConfigService;

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

function mockFetchJson(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('normalizeOrganic', () => {
  const raw = [
    { title: 'React Blog', link: 'https://react.dev/blog?a=1', snippet: ' great ' },
    { title: 'Dup', link: 'https://react.dev/blog/', snippet: 'dup' },
    { title: 'XSS', link: 'javascript:alert(1)', snippet: 'evil' },
    { title: 'No link', snippet: 'missing' },
    { title: '  ', link: 'https://example.com/nameless', snippet: '' },
  ];

  it('keeps safe URLs, drops unsafe ones, de-duplicates, caps count', () => {
    const results = normalizeOrganic(raw, 5);
    expect(results.map((r) => r.url)).toEqual([
      'https://react.dev/blog?a=1',
      'https://example.com/nameless',
    ]);
    expect(results[0]).toMatchObject({ title: 'React Blog', domain: 'react.dev', snippet: 'great' });
    // Nameless hit falls back to its domain as the title.
    expect(results[1].title).toBe('example.com');
  });

  it('respects maxResults', () => {
    expect(normalizeOrganic(raw, 1)).toHaveLength(1);
  });

  it('handles non-array payloads', () => {
    expect(normalizeOrganic(null, 5)).toEqual([]);
    expect(normalizeOrganic('oops', 5)).toEqual([]);
  });
});

describe('SerperWebSearchProvider', () => {
  const providerWithKey = () =>
    new SerperWebSearchProvider(configWith({ 'websearch.serperApiKey': 'test-key' }));

  it('returns misconfigured without an API key (no network call)', async () => {
    const provider = new SerperWebSearchProvider(configWith({}));
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    await expect(provider.search('hi')).resolves.toEqual({ ok: false, errorType: 'misconfigured' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('normalizes a successful Serper response', async () => {
    mockFetchJson(200, {
      organic: [{ title: 'T', link: 'https://a.dev/1', snippet: 'S' }],
    });
    await expect(providerWithKey().search('react')).resolves.toEqual({
      ok: true,
      results: [{ title: 'T', url: 'https://a.dev/1', domain: 'a.dev', snippet: 'S' }],
    });
    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['X-API-KEY']).toBe('test-key');
  });

  it('classifies HTTP failures without leaking detail', async () => {
    mockFetchJson(429, {});
    await expect(providerWithKey().search('x')).resolves.toEqual({
      ok: false,
      errorType: 'rate_limited',
    });
    mockFetchJson(401, {});
    await expect(providerWithKey().search('x')).resolves.toEqual({
      ok: false,
      errorType: 'unauthorized',
    });
    mockFetchJson(500, {});
    await expect(providerWithKey().search('x')).resolves.toEqual({
      ok: false,
      errorType: 'provider_error',
    });
  });

  it('classifies malformed payloads and network failures', async () => {
    mockFetchJson(200, { organic: 'nope' });
    await expect(providerWithKey().search('x')).resolves.toEqual({
      ok: false,
      errorType: 'invalid_response',
    });
    global.fetch = jest.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;
    await expect(providerWithKey().search('x')).resolves.toEqual({
      ok: false,
      errorType: 'network',
    });
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    global.fetch = jest.fn().mockRejectedValue(abortError) as unknown as typeof fetch;
    await expect(providerWithKey().search('x')).resolves.toEqual({
      ok: false,
      errorType: 'timeout',
    });
  });
});
