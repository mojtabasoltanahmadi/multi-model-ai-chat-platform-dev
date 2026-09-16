import { contentDisposition } from './content-disposition';

describe('contentDisposition', () => {
  it('serves previewable files inline with the real (percent-encoded) name', () => {
    const header = contentDisposition('inline', 'گزارش فروش.pdf');

    expect(header.startsWith('inline; ')).toBe(true);
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('گزارش فروش.pdf')}`);
  });

  it('marks downloads as attachments', () => {
    const header = contentDisposition('attachment', 'sheet.xlsx');

    expect(header.startsWith('attachment; ')).toBe(true);
    expect(header).toContain('filename="sheet.xlsx"');
    expect(header).toContain("filename*=UTF-8''sheet.xlsx");
  });

  it('cannot be broken open by a hostile filename', () => {
    const header = contentDisposition('attachment', 'ev"il\\na\rme\n.pdf');

    // The ASCII fallback keeps no quote, backslash, CR or LF...
    const fallback = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
    expect(fallback).toBe('evilname.pdf');
    // ...and the encoded copy has no raw control characters either.
    expect(header).not.toMatch(/[\r\n]/);
  });

  it('falls back to a placeholder when nothing usable remains', () => {
    const header = contentDisposition('inline', '""\\\\');

    expect(header).toContain('filename="file"');
  });
});
