import { ConfigService } from '@nestjs/config';
import { WebSearchService } from './websearch.service';
import type { WebSearchOutcome, WebSearchProvider } from './websearch.types';

const configWith = (values: Record<string, unknown>) =>
  ({ get: (key: string) => values[key] }) as ConfigService;

const BASE_CONFIG = {
  'websearch.enabled': true,
  'websearch.maxResults': 5,
  'websearch.timeoutMs': 5000,
  'websearch.maxQueryLength': 500,
  'websearch.maxContextChars': 6000,
};

const stubProvider = (outcome: WebSearchOutcome, apiKey = 'k') => {
  const search = jest.fn().mockResolvedValue(outcome);
  return { provider: { name: 'stub', search, apiKey } as unknown as WebSearchProvider & { apiKey: string }, search };
};

describe('WebSearchService', () => {
  it('degrades without calling the provider when disabled (Invariant 1)', async () => {
    const { provider, search } = stubProvider({ ok: true, results: [] });
    const service = new WebSearchService(provider as any, configWith({ ...BASE_CONFIG, 'websearch.enabled': false }));
    const run = await service.runForTurn('hello');
    expect(search).not.toHaveBeenCalled();
    expect(run).toEqual({ sources: [], contextBlock: '', warning: expect.any(String) });
  });

  it('degrades when no provider key is configured (never throws)', async () => {
    const { provider, search } = stubProvider({ ok: true, results: [] }, '');
    const service = new WebSearchService(provider as any, configWith(BASE_CONFIG));
    const run = await service.runForTurn('hello');
    expect(search).not.toHaveBeenCalled();
    expect(run.warning).toContain('پیکربندی');
  });

  it('returns sources + context on success', async () => {
    const { provider } = stubProvider({
      ok: true,
      results: [{ title: 'T', url: 'https://a.dev/1', domain: 'a.dev', snippet: 'S' }],
    });
    const service = new WebSearchService(provider as any, configWith(BASE_CONFIG));
    const run = await service.runForTurn('react?');
    expect(run.warning).toBeNull();
    expect(run.sources).toEqual([
      { title: 'T', url: 'https://a.dev/1', domain: 'a.dev', snippet: 'S' },
    ]);
    expect(run.contextBlock).toContain('https://a.dev/1');
  });

  it('degrades with a safe warning on provider failure (Invariant 6)', async () => {
    const { provider } = stubProvider({ ok: false, errorType: 'timeout' });
    const service = new WebSearchService(provider as any, configWith(BASE_CONFIG));
    const run = await service.runForTurn('react?');
    expect(run).toEqual({ sources: [], contextBlock: '', warning: expect.stringContaining('طول کشید') });
  });

  it('warns (no crash) on empty results', async () => {
    const { provider } = stubProvider({ ok: true, results: [] });
    const service = new WebSearchService(provider as any, configWith(BASE_CONFIG));
    const run = await service.runForTurn('react?');
    expect(run.sources).toEqual([]);
    expect(run.warning).toContain('نتیجه‌ای');
  });

  it('truncates overlong queries (Invariant 8)', async () => {
    const { provider, search } = stubProvider({ ok: true, results: [] });
    const service = new WebSearchService(provider as any, configWith(BASE_CONFIG));
    await service.runForTurn('x'.repeat(2000));
    expect(search).toHaveBeenCalledTimes(1);
    expect((search.mock.calls[0] as [string])[0]).toHaveLength(500);
  });
});
