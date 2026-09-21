import { ConfigService } from '@nestjs/config';
import { fork } from 'child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { InvalidPDFException, PasswordException } from 'pdf-parse';
import { FileExtractionService, PermanentExtractionError } from './file-extraction.service';
import { legacyXlsBuffer, tinyPngBuffer, xlsxBuffer } from '../test/fixtures';

/**
 * pdf-parse is mocked here: its pdf.js worker relies on dynamic import, which
 * Jest's VM only supports with --experimental-vm-modules. The REAL extraction
 * path is covered end-to-end by scripts/file-processing-test.mjs against a
 * running stack (Node, no Jest VM) — these tests pin the mapping rules:
 * empty → permanent, corrupt/encrypted → permanent, unknown → transient.
 *
 * The OCR pipeline is mocked at the child_process.fork boundary: tesseract.js
 * runs in a dedicated child process (file-ocr-child.ts) so its failures can
 * never crash the API process; these tests pin the parent-side contract —
 * task payload, transient-vs-permanent classification, child release, and
 * the cache-directory creation.
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

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  fork: jest.fn(),
}));

const pdfModule = jest.requireMock('pdf-parse') as {
  __getText: jest.Mock;
  __destroy: jest.Mock;
};
const mockFork = fork as unknown as jest.Mock;

/** Bare-bones forked-child stub; tests emit IPC messages on it directly. */
function makeFakeChild(): ChildProcess & { send: jest.Mock; kill: jest.Mock } {
  const child = new EventEmitter() as unknown as ChildProcess & {
    send: jest.Mock;
    kill: jest.Mock;
  };
  const sendMock = jest.fn((...args: unknown[]) => {
    const callback = args.find(
      (arg) => typeof arg === 'function',
    ) as ((err: Error | null) => void) | undefined;
    if (callback) setImmediate(() => callback(null));
    return true;
  });
  (child as unknown as { send: unknown }).send = sendMock;
  (child as unknown as { kill: unknown }).kill = jest.fn();
  return child;
}

const specCacheDir = join(tmpdir(), `ocr-cache-spec-${process.pid}`);

function makeService(overrides: Record<string, unknown> = {}): FileExtractionService {
  const config: Record<string, unknown> = {
    'ocr.language': 'eng',
    'ocr.cachePath': specCacheDir,
    'ocr.dataPath': '',
    'ocr.timeoutMs': 5000,
    ...overrides,
  };
  const configService = {
    get: (key: string) => config[key],
  } as unknown as ConfigService;
  return new FileExtractionService(configService);
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
    await expect(
      service.extract('excel', legacyXlsBuffer()),
    ).rejects.toBeInstanceOf(PermanentExtractionError);
  });
});

describe('FileExtractionService — Image OCR (child-process isolation)', () => {
  let child: ChildProcess & { send: jest.Mock; kill: jest.Mock };

  beforeEach(() => {
    mockFork.mockReset();
    child = makeFakeChild();
    mockFork.mockReturnValue(child);
  });

  it('forks the compiled child with advanced serialization and sends the task', async () => {
    const pending = makeService().extract('image', tinyPngBuffer());
    child.emit('message', { ok: true, text: 'Hello' });
    await pending;

    expect(mockFork).toHaveBeenCalledWith(
      expect.stringContaining('file-ocr-child.js'),
      [],
      expect.objectContaining({ serialization: 'advanced' }),
    );
    const task = child.send.mock.calls[0][0] as Record<string, unknown>;
    expect(task).toMatchObject({
      language: 'eng',
      cachePath: expect.any(String),
      psm: 6,
    });
    // OCR_DATA_PATH unset → data-path options must not be sent at all.
    expect(task).not.toHaveProperty('langPath');
    expect(task).not.toHaveProperty('dataPath');
    expect(child.kill).toHaveBeenCalled();
  });

  it('creates the tesseract cache directory (tesseract never mkdirs it itself)', async () => {
    const pending = makeService().extract('image', tinyPngBuffer());
    child.emit('message', { ok: true, text: 'x' });
    await pending;

    expect(existsSync(specCacheDir)).toBe(true);
  });

  it('sends langPath/dataPath only when a local tessdata dir is configured', async () => {
    const pending = makeService({ 'ocr.dataPath': 'D:/tessdata' }).extract(
      'image',
      tinyPngBuffer(),
    );
    child.emit('message', { ok: true, text: 'x' });
    await pending;

    const task = child.send.mock.calls[0][0] as Record<string, unknown>;
    // Configured paths are resolved to absolute (Windows backslashes).
    expect(task).toMatchObject({ langPath: resolve('D:/tessdata'), dataPath: resolve('D:/tessdata') });
  });

  it('returns the recognized (child-cleaned) text and releases the child', async () => {
    const pending = makeService().extract('image', tinyPngBuffer());
    child.emit('message', { ok: true, text: 'Hello from OCR' });

    await expect(pending).resolves.toEqual({ text: 'Hello from OCR' });
    expect(child.kill).toHaveBeenCalled();
  });

  it('fails permanently when the image contains no recognizable text', async () => {
    const pending = makeService().extract('image', tinyPngBuffer());
    child.emit('message', { ok: true, text: '   \n ' });

    await expect(pending).rejects.toThrow(/متنی در این تصویر شناسایی نشد/);
    expect(child.kill).toHaveBeenCalled();
  });

  it('treats a language-data download failure as transient (retryable)', async () => {
    const pending = makeService().extract('image', tinyPngBuffer());
    child.emit('message', { ok: false, message: 'TypeError: fetch failed' });

    const error = await pending.catch((e) => e);
    expect(error).not.toBeInstanceOf(PermanentExtractionError);
    expect(error.message).toContain('fetch failed');
    expect(child.kill).toHaveBeenCalled();
  });

  it('treats a content-level OCR failure as permanent', async () => {
    const pending = makeService().extract('image', tinyPngBuffer());
    child.emit('message', { ok: false, message: 'wasm blew up' });

    await expect(pending).rejects.toThrow(/پردازش OCR روی این تصویر ممکن نشد/);
  });

  it('treats a crashed child as transient and releases it', async () => {
    const pending = makeService().extract('image', tinyPngBuffer());
    child.emit('error', new Error('spawn failure'));

    const error = await pending.catch((e) => e);
    expect(error).not.toBeInstanceOf(PermanentExtractionError);
    expect(error.message).toContain('spawn failure');
    expect(child.kill).toHaveBeenCalled();
  });

  it('treats an unexpected child exit as transient (no hang, no crash)', async () => {
    const pending = makeService().extract('image', tinyPngBuffer());
    child.emit('exit', 1, null);

    const error = await pending.catch((e) => e);
    expect(error).not.toBeInstanceOf(PermanentExtractionError);
    expect(error.message).toContain('died unexpectedly');
  });

  it('times out and kills the child when OCR never completes', async () => {
    const pending = makeService({ 'ocr.timeoutMs': 20 }).extract('image', tinyPngBuffer());

    await expect(pending).rejects.toThrow(/OCR timed out/);
    expect(child.kill).toHaveBeenCalled();
  }, 2000);
});
