import {
  detectContentKind,
  familyOfExtension,
  familyOfMime,
  isAllowedDeclaredMime,
  looksLikeOle2,
  sanitizeOriginalName,
  validateUploadedFile,
} from './file-validation';
import {
  legacyXlsBuffer,
  minimalPdfBuffer,
  tinyJpegBuffer,
  tinyPngBuffer,
  xlsxBuffer,
} from '../test/fixtures';

const MAX = 10 * 1024 * 1024;

function validate(
  buffer: Buffer,
  declaredMime: string,
  originalName: string,
  maxFileSizeBytes = MAX,
) {
  return validateUploadedFile({
    declaredMime,
    originalName,
    size: buffer.length,
    maxFileSizeBytes,
    buffer,
  });
}

describe('file-validation — content detection', () => {
  it('detects PDF, PNG, JPEG, XLSX and legacy XLS', () => {
    expect(detectContentKind(minimalPdfBuffer())).toEqual({
      kind: 'pdf',
      resolvedMime: 'application/pdf',
    });
    expect(detectContentKind(tinyPngBuffer())).toEqual({
      kind: 'image',
      resolvedMime: 'image/png',
    });
    expect(detectContentKind(tinyJpegBuffer())).toEqual({
      kind: 'image',
      resolvedMime: 'image/jpeg',
    });
    expect(detectContentKind(xlsxBuffer({ A: [['x']] }))).toEqual({
      kind: 'excel',
      resolvedMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(detectContentKind(legacyXlsBuffer())).toEqual({
      kind: 'excel',
      resolvedMime: 'application/vnd.ms-excel',
    });
  });

  it('returns null for unrecognized content', () => {
    expect(detectContentKind(Buffer.from('this is not a document'))).toBeNull();
    expect(detectContentKind(Buffer.alloc(0))).toBeNull();
  });

  it('rejects an OLE2 container that is not a workbook (e.g. a Word file)', () => {
    const ole2WithoutWorkbook = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(1024, 0x11),
    ]);
    expect(looksLikeOle2(ole2WithoutWorkbook)).toBe(true);
    expect(detectContentKind(ole2WithoutWorkbook)).toBeNull();
  });

  it('rejects a plain zip that is not an OOXML workbook', () => {
    const zip = Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.from('not-office')]);
    expect(detectContentKind(zip)).toBeNull();
  });

  it('allows exactly the MVP MIME families', () => {
    expect(isAllowedDeclaredMime('application/pdf')).toBe(true);
    expect(isAllowedDeclaredMime('image/png')).toBe(true);
    expect(isAllowedDeclaredMime('image/jpeg')).toBe(true);
    expect(isAllowedDeclaredMime('application/vnd.ms-excel')).toBe(true);
    expect(
      isAllowedDeclaredMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).toBe(true);
    expect(isAllowedDeclaredMime('text/plain')).toBe(false);
    expect(isAllowedDeclaredMime('application/zip')).toBe(false);
    expect(isAllowedDeclaredMime('image/gif')).toBe(false);
    expect(familyOfMime('image/png')).toBe('image');
    expect(familyOfMime('application/zip')).toBeNull();
  });
});

describe('file-validation — upload rules', () => {
  it('accepts a valid PDF whose claimed type and extension agree', () => {
    expect(validate(minimalPdfBuffer(), 'application/pdf', 'report.pdf')).toEqual({
      kind: 'pdf',
      resolvedMime: 'application/pdf',
    });
  });

  it('accepts an image and resolves the canonical MIME from content', () => {
    expect(validate(tinyPngBuffer(), 'image/png', 'photo.PNG')).toEqual({
      kind: 'image',
      resolvedMime: 'image/png',
    });
  });

  it('accepts a spreadsheet with an uppercase extension', () => {
    const buffer = xlsxBuffer({ Sheet1: [['name'], ['Ali']] });
    expect(
      validate(
        buffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'customers.XLSX',
      ),
    ).toMatchObject({ kind: 'excel' });
  });

  it('rejects an empty file', () => {
    expect(() => validate(Buffer.alloc(0), 'application/pdf', 'empty.pdf')).toThrow(
      /فایل خالی است/,
    );
  });

  it('rejects a file above the configured size limit', () => {
    expect(() => validate(minimalPdfBuffer(), 'application/pdf', 'big.pdf', 10)).toThrow(
      /حجم فایل بیش از حد مجاز/,
    );
  });

  it('rejects unsupported declared MIME types', () => {
    expect(() => validate(minimalPdfBuffer(), 'text/plain', 'readme.pdf')).toThrow(
      /نوع فایل پشتیبانی نمی‌شود/,
    );
  });

  it('rejects MIME spoofing (PNG bytes claimed as PDF)', () => {
    expect(() => validate(tinyPngBuffer(), 'application/pdf', 'fake.pdf')).toThrow(
      /مطابقت ندارد/,
    );
  });

  it('rejects content that matches no supported signature', () => {
    expect(() =>
      validate(Buffer.from('PK-not-really-an-office-file'), 'application/pdf', 'broken.pdf'),
    ).toThrow(/قابل تشخیص نیست/);
  });

  it('rejects a supported type behind an unsupported extension', () => {
    expect(() => validate(minimalPdfBuffer(), 'application/pdf', 'report.exe')).toThrow(
      /پسوند فایل پشتیبانی نمی‌شود/,
    );
  });

  it('rejects an extension that contradicts the content', () => {
    expect(() => validate(tinyPngBuffer(), 'image/png', 'photo.xlsx')).toThrow(
      /پسوند فایل با محتوای آن مطابقت ندارد/,
    );
  });

  it('lets content decide when the name has no extension', () => {
    expect(validate(minimalPdfBuffer(), 'application/pdf', 'no-extension')).toEqual({
      kind: 'pdf',
      resolvedMime: 'application/pdf',
    });
  });

  it('classifies extensions into families, flagging unsupported ones', () => {
    expect(familyOfExtension('a.pdf')).toBe('pdf');
    expect(familyOfExtension('a.XLS')).toBe('excel');
    expect(familyOfExtension('a.jpeg')).toBe('image');
    expect(familyOfExtension('a.zip')).toBe('unsupported');
    expect(familyOfExtension('a')).toBeNull();
    expect(familyOfExtension('.pdf')).toBe('pdf');
  });
});

describe('file-validation — filename sanitization', () => {
  it('strips directory traversal and keeps only the base name', () => {
    expect(sanitizeOriginalName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeOriginalName('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe');
    expect(sanitizeOriginalName('/tmp/upload/report.pdf')).toBe('report.pdf');
  });

  it('removes control characters', () => {
    expect(sanitizeOriginalName('re\u0000p\u001fort.pdf')).toBe('report.pdf');
  });

  it('falls back for empty or whitespace-only names', () => {
    expect(sanitizeOriginalName('   ')).toBe('بدون‌نام');
    expect(sanitizeOriginalName('///')).toBe('بدون‌نام');
  });

  it('truncates absurdly long names to the column limit', () => {
    const long = `${'x'.repeat(400)}.pdf`;
    expect(sanitizeOriginalName(long).length).toBe(255);
  });
});
