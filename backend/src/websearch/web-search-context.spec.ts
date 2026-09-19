import { buildWebSearchPrompt } from './web-search-context';
import type { WebSearchResult } from './websearch.types';

const results: WebSearchResult[] = [
  { title: 'React Blog', url: 'https://react.dev/blog', domain: 'react.dev', snippet: 'React 19 is out.' },
  { title: 'Docs', url: 'https://react.dev/docs', domain: 'react.dev', snippet: 'Read the docs.' },
];

describe('buildWebSearchPrompt', () => {
  it('returns the question untouched when there are no results', () => {
    expect(buildWebSearchPrompt([], 'سلام', 6000)).toBe('سلام');
  });

  it('numbers sources and bakes in the safety instructions', () => {
    const prompt = buildWebSearchPrompt(results, 'React 19؟', 6000);
    expect(prompt).toContain('[1]');
    expect(prompt).toContain('[2]');
    expect(prompt).toContain('https://react.dev/blog');
    expect(prompt).toContain('React 19؟');
    // Anti-hallucination + prompt-injection guardrails travel with the data.
    expect(prompt).toContain('جعلی نساز');
    expect(prompt).toContain('غیرقابل اعتماد');
    expect(prompt).toContain('system prompt');
  });

  it('fits whole entries only within the context budget', () => {
    const tiny = buildWebSearchPrompt(results, 'q', 40);
    // Bodies do not fit — titles/URLs fallback keeps sources attributable.
    expect(tiny).toContain('https://react.dev/blog');
    expect(tiny).not.toContain('React 19 is out.');
  });
});
