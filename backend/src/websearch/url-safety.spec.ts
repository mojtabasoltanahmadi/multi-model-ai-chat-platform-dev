import { extractDomain, isSafeHttpUrl, normalizeUrlKey } from './url-safety';

describe('url-safety', () => {
  it('accepts only absolute http/https URLs', () => {
    expect(isSafeHttpUrl('https://react.dev/blog')).toBe(true);
    expect(isSafeHttpUrl('http://example.com/x')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<h1>x</h1>')).toBe(false);
    expect(isSafeHttpUrl('ftp://example.com/f')).toBe(false);
    expect(isSafeHttpUrl('/relative/path')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl(null)).toBe(false);
    expect(isSafeHttpUrl(undefined)).toBe(false);
  });

  it('derives the lowercase host, never trusting provider input', () => {
    expect(extractDomain('https://React.Dev/Blog?a=1')).toBe('react.dev');
    expect(extractDomain('javascript:alert(1)')).toBeNull();
  });

  it('de-duplicates tracker variants of the same page', () => {
    const a = normalizeUrlKey('https://example.com/guide?utm_source=x#top');
    const b = normalizeUrlKey('https://example.com/guide/');
    const c = normalizeUrlKey('https://example.com/other');
    expect(a).toBe('https://example.com/guide');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(normalizeUrlKey('data:x')).toBeNull();
  });
});
