/**
 * Builds a `Content-Disposition` value for a user-supplied filename.
 *
 * The name is untrusted (it reaches us from the upload body), so:
 *   - an ASCII fallback is emitted for legacy clients, with quotes/backslashes
 *     and control characters stripped, so the header can never be broken open;
 *   - the real name is carried in RFC 5987 `filename*`, percent-encoded, which
 *     is what makes Persian filenames survive the round trip.
 */
export function contentDisposition(
  disposition: 'inline' | 'attachment',
  originalName: string,
): string {
  const fallback =
    originalName
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f"\\]/g, '')
      .replace(/[^\x20-\x7e]/g, '_')
      .trim()
      .slice(0, 100) || 'file';

  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(originalName)}`;
}
