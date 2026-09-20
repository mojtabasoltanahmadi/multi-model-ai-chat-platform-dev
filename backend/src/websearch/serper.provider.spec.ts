import { ConfigService } from '@nestjs/config';
import {
  maskApiKey,
  normalizeApiKey,
  normalizeOrganic,
  SerperWebSearchProvider,
} from './serper.provider';

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
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
  }) as unknown as typeof fetch;
}

/** A 403/401 answered by an HTML error PAGE (network edge), not Serper's JSON API. */
function mockFetchHtmlError(status: number) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    json: async () => {
      throw new Error('not json');
    },
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

  it('treats an HTML 403 page as unauthorized and blames the network edge, never the key', async () => {
    // google.serper.dev is served behind Google's front end: a 403 with an
    // HTML body means the request was blocked by client IP BEFORE Serper's
    // application — a valid key cannot fix it (egress route must).
    mockFetchHtmlError(403);
    const provider = providerWithKey();
    const warn = jest.spyOn(provider['logger'], 'warn');

    await expect(provider.search('x')).resolves.toEqual({
      ok: false,
      errorType: 'unauthorized',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('blocked BEFORE Serper'));
  });

  it('sends a normalized X-API-KEY: config whitespace and quotes never reach the header', async () => {
    mockFetchJson(200, { organic: [] });
    const provider = new SerperWebSearchProvider(
      configWith({ 'websearch.serperApiKey': '  "real-key-40-chars-long-xxxxxxxx"\r' }),
    );
    await provider.search('x');

    const [, options] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['X-API-KEY']).toBe(
      'real-key-40-chars-long-xxxxxxxx',
    );
  });

  it('logs key PRESENCE at boot with a masked fingerprint — never the secret', () => {
    const provider = new SerperWebSearchProvider(
      configWith({ 'websearch.serperApiKey': '0123456789abcdef0123456789abcdef01234567' }),
    );
    const log = jest.spyOn(provider['logger'], 'log');
    provider.onModuleInit();

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('SERPER KEY LOADED: 01234***** (len=40)'),
    );
    // The full key must not appear in the log payload.
    expect(log.mock.calls[0][0]).not.toContain('0123456789abcdef0123456789abcdef01234567');
  });

  it('logs a MISSING key at boot (degradation warning, no crash)', () => {
    const provider = new SerperWebSearchProvider(configWith({}));
    const warn = jest.spyOn(provider['logger'], 'warn');

    expect(() => provider.onModuleInit()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SERPER KEY MISSING'));
  });
});

describe('normalizeApiKey', () => {
  it('trims whitespace including CRLF from hand-edited env files', () => {
    expect(normalizeApiKey('  abc  ')).toBe('abc');
    expect(normalizeApiKey('abc\r\n')).toBe('abc');
    expect(normalizeApiKey('')).toBe('');
  });

  it('strips ONE matching pair of surrounding quotes (never inner content)', () => {
    expect(normalizeApiKey('"abc"')).toBe('abc');
    expect(normalizeApiKey("'abc'")).toBe('abc');
    expect(normalizeApiKey('"abc')).toBe('"abc');
    expect(normalizeApiKey("a'b'c")).toBe("a'b'c");
  });
});

describe('maskApiKey', () => {
  it('shows only a prefix and the length', () => {
    expect(maskApiKey('0123456789abcdef')).toBe('01234***** (len=16)');
  });

  it('masks short and empty values entirely', () => {
    expect(maskApiKey('abc')).toBe('***** (len=3)');
    expect(maskApiKey('')).toBe('<empty>');
  });
});
