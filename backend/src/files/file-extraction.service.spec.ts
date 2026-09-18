import { ConfigService } from '@nestjs/config';
import { createWorker } from 'tesseract.js';
import { InvalidPDFException, PasswordException } from 'pdf-parse';
import { FileExtractionService, PermanentExtractionError } from './file-extraction.service';
import { legacyXlsBuffer, tinyPngBuffer, xlsxBuffer } from '../test/fixtures';

/**
 * pdf-parse is mocked here: its pdf.js worker relies on dynamic import, which
 * Jest's VM only supports with --experimental-vm-modules. The REAL extraction
 * path is covered end-to-end by scripts/file-processing-test.mjs against a
 * running stack (Node, no Jest VM) — these tests pin the mapping rules:
 * empty → permanent, corrupt/encrypted → permanent, unknown → transient.
 */
jest.mock('pdf-parse', () => {
  class MockInvalidPDFException extends Error {}
  class MockPasswordException extends Error {}
  const getText = jest.fn();
  const destroy = jest.fn();
  class MockPDFParse {
    getText = getText;
    destroy = destroy;
    constructor(public readonly options: unknown) {}
  }
  return {
    PDFParse: MockPDFParse,
    InvalidPDFException: MockInvalidPDFException,
    PasswordException: MockPasswordException,
    __getText: getText,
    __destroy: destroy,
  };
});

jest.mock('tesseract.js', () => ({ createWorker: jest.fn() }));

const pdfModule = jest.requireMock('pdf-parse') as {
  __getText: jest.Mock;
  __destroy: jest.Mock;
};
const mockCreateWorker = createWorker as unknown as jest.Mock;

function makeService(): FileExtractionService {
  const configService = {
    get: (key: string) =>
      ({
        'ocr.language': 'eng',
        'ocr.cachePath': '/tmp/ocr-cache',
        'ocr.dataPath': '',
      })[key],
  } as unknown as ConfigService;
  return new FileExtractionService(configService);
}

/** OCR worker stub; tesseract's real engine is never touched in unit tests. */
function stubOcr(text: string) {
  const terminate = jest.fn().mockResolvedValue(undefined);
  mockCreateWorker.mockResolvedValue({
    recognize: jest.fn().mockResolvedValue({ data: { text } }),
    terminate,
  });
  return { terminate };
}

describe('FileExtractionService — PDF', () => {
  const service = makeService();

  beforeEach(() => {
    pdfModule.__getText.mockReset();
    pdfModule.__destroy.mockReset().mockResolvedValue(undefined);
  });

  it('extracts each page and labels them', async () => {
    pdfModule.__getText.mockResolvedValue({
      pages: [
        { num: 1, text: 'Hello File Test' },
        { num: 2, text: 'Second page' },
      ],
    });

    const { text } = await service.extract('pdf', Buffer.from('%PDF-1.4'));

    expect(text).toContain('Hello File Test');
    expect(text).toContain('Second page');
    expect(text).toContain('صفحه ۱'.replace('۱', '1'));
    expect(pdfModule.__destroy).toHaveBeenCalled();
  });

  it('fails explicitly when no page carries extractable text (scanned PDF)', async () => {
    pdfModule.__getText.mockResolvedValue({
      pages: [
        { num: 1, text: '   ' },
        { num: 2, text: '' },
      ],
    });

    await expect(service.extract('pdf', Buffer.from('%PDF-1.4'))).rejects.toThrow(
      /متنی از این PDF قابل استخراج نیست/,
    );
  });

  it('reports a corrupt PDF as a permanent failure', async () => {
    pdfModule.__getText.mockRejectedValue(new InvalidPDFException('bad xref'));

    const error = await service.extract('pdf', Buffer.from('%PDF-1.4')).catch((e) => e);
    expect(error).toBeInstanceOf(PermanentExtractionError);
    expect(error.message).toContain('خراب');
  });

  it('reports an encrypted PDF as a permanent failure with its own message', async () => {
    pdfModule.__getText.mockRejectedValue(new PasswordException('locked'));

    await expect(service.extract('pdf', Buffer.from('%PDF-1.4'))).rejects.toThrow(
      /رمزنگاری شده/,
    );
  });

  it('treats an unknown parser error as transient (retryable, not permanent)', async () => {
    pdfModule.__getText.mockRejectedValue(new Error('ECONNRESET while reading'));

    const error = await service.extract('pdf', Buffer.from('%PDF-1.4')).catch((e) => e);
    expect(error).not.toBeInstanceOf(PermanentExtractionError);
    expect(error.message).toContain('ECONNRESET');
  });
});

describe('FileExtractionService — Excel', () => {
  const service = makeService();

  it('renders every sheet as a pipe-separated table', async () => {
    const buffer = xlsxBuffer({
      Customers: [
        ['Name', 'Age', 'City'],
        ['Ali', 22, 'Mashhad'],
        ['Sara', 25, 'Tehran'],
      ],
      Notes: [['note one'], ['note two']],
    });

    const { text } = await service.extract('excel', buffer);
    expect(text).toContain('Sheet: Customers');
    expect(text).toContain('Name | Age | City');
    expect(text).toContain('Ali | 22 | Mashhad');
    expect(text).toContain('Sheet: Notes');
    expect(text).toContain('note two');
  });

  it('marks empty sheets inside a non-empty workbook', async () => {
    const buffer = xlsxBuffer({ Data: [['x']], Empty: [] });
    const { text } = await service.extract('excel', buffer);
    expect(text).toContain('Sheet: Empty');
    expect(text).toContain('(این شیت خالی است)');
  });

  it('fails permanently for a workbook with no data at all', async () => {
    await expect(service.extract('excel', xlsxBuffer({ Sheet1: [] }))).rejects.toThrow(
      /هیچ داده قابل استخراجی ندارد/,
    );
  });

  it('fails permanently for text mislabelled as a spreadsheet', async () => {
    // SheetJS parses plain text as CSV, so the extractor must guard on the
    // container signature first.
    await expect(
      service.extract('excel', Buffer.from('this is definitely not a spreadsheet')),
    ).rejects.toBeInstanceOf(PermanentExtractionError);
  });

  it('fails permanently for an OLE2 container that is not a workbook', async () => {
    await expect(service.extract('excel', legacyXlsBuffer())).rejects.toBeInstanceOf(
      PermanentExtractionError,
    );
  });
});

describe('FileExtractionService — Image OCR', () => {
  beforeEach(() => mockCreateWorker.mockReset());

  it('returns the recognized text and releases the worker', async () => {
    const { terminate } = stubOcr('  Hello from OCR\n');
    const service = makeService();

    const result = await service.extract('image', tinyPngBuffer());

    expect(result.text).toBe('Hello from OCR');
    expect(terminate).toHaveBeenCalled();
  });

  it('fails honestly when the image contains no recognizable text', async () => {
    stubOcr('   \n  ');
    const service = makeService();

    await expect(service.extract('image', tinyPngBuffer())).rejects.toThrow(
      /متنی در این تصویر شناسایی نشد/,
    );
  });

  it('reports an OCR engine failure as permanent and terminates the worker', async () => {
    const terminate = jest.fn().mockResolvedValue(undefined);
    mockCreateWorker.mockResolvedValue({
      recognize: jest.fn().mockRejectedValue(new Error('wasm blew up')),
      terminate,
    });
    const service = makeService();

    await expect(service.extract('image', tinyPngBuffer())).rejects.toThrow(
      /پردازش OCR روی این تصویر ممکن نشد/,
    );
    expect(terminate).toHaveBeenCalled();
  });
});
