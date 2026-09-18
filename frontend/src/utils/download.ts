/**
 * Triggers a real browser download for an object URL, without navigating or
 * opening a tab. The filename wins over the server's Content-Disposition, so
 * the Persian original name survives.
 */
export function downloadUrl(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
