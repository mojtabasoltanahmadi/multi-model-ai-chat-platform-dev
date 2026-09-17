/**
 * Multipart bodies carry the filename as raw bytes in a header, and busboy
 * (behind multer) decodes those bytes as latin1. A UTF-8 name such as
 * «عکس-نمونه.png» therefore arrives as `Ø¹Ú©Ø³-Ù†Ù…ÙˆÙ†Ù‡.png`, and that
 * mojibake is what would be shown to the user and stored in the database.
 *
 * Re-decoding the same bytes as UTF-8 restores the original name. The repair is
 * skipped when it cannot help: ASCII names have nothing to fix, and names that
 * are genuinely latin1 (a rarer, non-UTF-8 client) would turn into replacement
 * characters — for those the raw value is kept.
 */
export function decodeUploadFilename(raw: string): string {
  // Nothing above U+00FF means every byte was already ASCII: leave it alone.
  if (!/[\u0080-\u00ff]/.test(raw)) return raw;

  const reinterpreted = Buffer.from(raw, 'latin1').toString('utf8');
  // U+FFFD means the bytes were not valid UTF-8, so the original name was not
  // mis-decoded UTF-8 either — better to keep what the client sent.
  return reinterpreted.includes('\ufffd') ? raw : reinterpreted;
}
