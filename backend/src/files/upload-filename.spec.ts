import { decodeUploadFilename } from './upload-filename';

/** What busboy hands over: the UTF-8 bytes of the name read as latin1. */
function asLatin1Mojibake(name: string): string {
  return Buffer.from(name, 'utf8').toString('latin1');
}

describe('decodeUploadFilename', () => {
  it('restores a Persian file name that arrived as latin1 mojibake', () => {
    const name = 'عکس-نمونه.png';
    const raw = asLatin1Mojibake(name);

    expect(raw).not.toBe(name); // the bug being fixed
    expect(decodeUploadFilename(raw)).toBe(name);
  });

  it('restores any non-ASCII name, not just Persian ones', () => {
    for (const name of ['résumé-2026.pdf', 'داده‌های-فروش.xlsx', '图片-१.png']) {
      expect(decodeUploadFilename(asLatin1Mojibake(name))).toBe(name);
    }
  });

  it('leaves plain ASCII names untouched', () => {
    expect(decodeUploadFilename('sales-summary.pdf')).toBe('sales-summary.pdf');
    expect(decodeUploadFilename('notes (1).xlsx')).toBe('notes (1).xlsx');
  });

  it('keeps a genuine latin1 name instead of inventing replacement characters', () => {
    // "café.pdf" sent by a client that really used latin1 bytes (0xe9).
    const latin1Name = 'caf\u00e9.pdf';

    expect(decodeUploadFilename(latin1Name)).toBe(latin1Name);
  });

  it('never returns an empty or replacement-bearing name', () => {
    const decoded = decodeUploadFilename(asLatin1Mojibake('تست.pdf'));

    expect(decoded).not.toContain('\ufffd');
    expect(decoded.length).toBeGreaterThan(0);
  });
});
