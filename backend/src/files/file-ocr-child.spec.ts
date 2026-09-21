import { createWorker, PSM } from 'tesseract.js';
import { preprocessForOcr } from './ocr-preprocess';
import { cleanOcrText, countMeaningfulChars, runOcrTask } from './file-ocr-child';
import type { OcrTask } from './file-ocr.contract';

/**
 * tesseract.js and sharp are mocked; the real engines are covered end-to-end
 * by scripts/file-processing-test.mjs against a running stack. These tests
 * pin the child-side contract:
 *  - an errorHandler MUST be registered (tesseract.js v7 otherwise throws
 *    inside its worker message listener — the uncaught exception that killed
 *    the API process before OCR was isolated into a child process),
 *  - preprocessing runs before the worker and corruption is reported as a
 *    structured content-level failure,
 *  - the primary pass sets the configured PSM; exactly one fallback pass
 *    (threshold + sparse text) may follow when the primary text is noise,
 *  - the worker is terminated on every path,
 *  - cleanup is whitespace-only — characters always survive untouched.
 */
jest.mock('tesseract.js', () => ({
  createWorker: jest.fn(),
  PSM: {
    SINGLE_BLOCK: '6',
    SPARSE_TEXT: '11',
  },
}));

jest.mock('./ocr-preprocess', () => ({
  preprocessForOcr: jest.fn(),
}));

const mockCreateWorker = createWorker as unknown as jest.Mock;
const mockPreprocess = preprocessForOcr as jest.Mock;
// PSM mock keeps the real string-enum values, so assertions read naturally.
const PSM_VALUES = PSM as unknown as { SINGLE_BLOCK: string; SPARSE_TEXT: string };

const NORMAL_BUFFER = Buffer.from('preprocessed-normal');
const THRESHOLD_BUFFER = Buffer.from('preprocessed-threshold');

function makeTask(overrides: Partial<OcrTask> = {}): OcrTask {
  return {
    language: 'fas+eng',
    buffer: Buffer.from('fake-png'),
    cachePath: '/cache',
    psm: 6,
    ...overrides,
  };
}

interface WorkerStub {
  setParameters: jest.Mock;
  recognize: jest.Mock;
  terminate: jest.Mock;
}

function stubWorker(recognizeResults: unknown[]): WorkerStub {
  const worker: WorkerStub = {
    setParameters: jest.fn().mockResolvedValue({}),
    recognize: jest.fn(),
    terminate: jest.fn().mockResolvedValue({}),
  };
  recognizeResults.forEach((result, index) => {
    worker.recognize.mockResolvedValueOnce(result as never);
    void index;
  });
  mockCreateWorker.mockResolvedValue(worker);
  return worker;
}

function stubPreprocess(): void {
  mockPreprocess.mockImplementation(async (_buffer: Buffer, strategy: string) =>
    strategy === 'threshold'
      ? { buffer: THRESHOLD_BUFFER, width: 640, height: 480 }
      : { buffer: NORMAL_BUFFER, width: 800, height: 600 },
  );
}

describe('file-ocr-child — runOcrTask', () => {
  beforeEach(() => {
    mockCreateWorker.mockReset();
    mockPreprocess.mockReset();
    stubPreprocess();
  });

  it('preprocesses, sets the configured PSM, recognizes once and terminates', async () => {
    const worker = stubWorker([{ data: { text: 'سلام World 12345' } }]);

    const outcome = await runOcrTask(makeTask());

    expect(mockPreprocess).toHaveBeenCalledWith(expect.any(Buffer), 'normal');
    expect(mockCreateWorker).toHaveBeenCalledWith('fas+eng', undefined, expect.any(Object));
    expect(worker.setParameters).toHaveBeenCalledWith({
      tessedit_pageseg_mode: PSM_VALUES.SINGLE_BLOCK,
    });
    expect(worker.recognize).toHaveBeenCalledTimes(1);
    expect(worker.recognize).toHaveBeenCalledWith(NORMAL_BUFFER);
    expect(outcome).toEqual({
      ok: true,
      text: 'سلام World 12345',
      meta: { width: 800, height: 600, strategy: 'normal', passes: 1 },
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('registers an errorHandler and only passes data-path options when configured', async () => {
    stubWorker([{ data: { text: 'hello world' } }]);

    await runOcrTask(makeTask());

    const options = mockCreateWorker.mock.calls[0][2] as Record<string, unknown>;
    expect(options.cachePath).toBe('/cache');
    expect(options.errorHandler).toBeInstanceOf(Function);
    expect(options.langPath).toBeUndefined();
    expect(options.dataPath).toBeUndefined();
    expect(() => (options.errorHandler as (m: unknown) => void)('boom')).not.toThrow();
  });

  it('forwards langPath/dataPath when the task carries them', async () => {
    stubWorker([{ data: { text: 'hello world' } }]);

    await runOcrTask(makeTask({ langPath: 'D:/tessdata', dataPath: 'D:/tessdata' }));

    const options = mockCreateWorker.mock.calls[0][2] as Record<string, unknown>;
    expect(options.langPath).toBe('D:/tessdata');
    expect(options.dataPath).toBe('D:/tessdata');
  });

  it('honors a custom primary PSM from the task', async () => {
    const worker = stubWorker([{ data: { text: 'hello world' } }]);

    await runOcrTask(makeTask({ psm: 11 }));

    expect(worker.setParameters).toHaveBeenCalledWith({
      tessedit_pageseg_mode: '11',
    });
  });

  it('runs exactly one threshold+sparse fallback when the primary text is pure noise', async () => {
    // Primary: symbol noise only (0 meaningful chars). Fallback: real text.
    const worker = stubWorker([
      { data: { text: '| + © 7' } },
      { data: { text: 'Settings Profile' } },
    ]);

    const outcome = await runOcrTask(makeTask());

    expect(worker.recognize).toHaveBeenCalledTimes(2);
    expect(worker.recognize).toHaveBeenNthCalledWith(2, THRESHOLD_BUFFER);
    expect(mockPreprocess).toHaveBeenNthCalledWith(2, expect.any(Buffer), 'threshold');
    expect(worker.setParameters).toHaveBeenLastCalledWith({
      tessedit_pageseg_mode: PSM_VALUES.SPARSE_TEXT,
    });
    expect(outcome).toEqual({
      ok: true,
      text: 'Settings Profile',
      meta: { width: 640, height: 480, strategy: 'threshold', passes: 2 },
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('keeps the primary result when the fallback finds nothing better', async () => {
    const worker = stubWorker([
      { data: { text: 'hello' } }, // 5 meaningful chars → NO fallback at all
      { data: { text: '' } },
    ]);

    const outcome = await runOcrTask(makeTask());

    expect(worker.recognize).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ meta: { strategy: 'normal', passes: 1 } });
  });

  it('keeps the primary result if the fallback is worse', async () => {
    const worker = stubWorker([
      { data: { text: '| ©' } }, // noise → fallback runs
      { data: { text: '' } }, // fallback finds nothing
    ]);

    const outcome = await runOcrTask(makeTask());

    expect(worker.recognize).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual({
      ok: true,
      text: '| ©',
      meta: { width: 800, height: 600, strategy: 'normal', passes: 2 },
    });
  });

  it('reports an undecodable image as a structured failure without creating a worker', async () => {
    mockPreprocess.mockRejectedValue(new Error('Input buffer contains unsupported image format'));

    const outcome = await runOcrTask(makeTask());

    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { message: string }).message).toContain('unsupported or corrupted image');
    expect(mockCreateWorker).not.toHaveBeenCalled();
  });

  it('reports createWorker failures as a structured outcome (no worker to terminate)', async () => {
    mockCreateWorker.mockRejectedValue('TypeError: fetch failed');

    const outcome = await runOcrTask(makeTask());

    expect(outcome).toEqual({ ok: false, message: 'TypeError: fetch failed' });
  });

  it('still terminates the worker when recognition fails', async () => {
    const worker = stubWorker([]);
    worker.recognize.mockRejectedValue(new Error('wasm blew up'));

    const outcome = await runOcrTask(makeTask());

    expect(outcome).toEqual({ ok: false, message: 'wasm blew up' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('signals readiness after the worker finished initializing', async () => {
    stubWorker([{ data: { text: 'hello world' } }]);
    const onReady = jest.fn();

    await runOcrTask(makeTask(), onReady);

    expect(onReady).toHaveBeenCalledTimes(1);
  });
});

describe('file-ocr-child — cleanOcrText', () => {
  it('normalizes line endings and strips the per-page form feed', () => {
    expect(cleanOcrText('a\r\nb\rc\f\nd')).toBe('a\nb\nc\nd');
  });

  it('trims trailing per-line whitespace and collapses space runs', () => {
    expect(cleanOcrText('hello   world\t\nnext  line  ')).toBe('hello world\nnext line');
  });

  it('collapses 3+ blank lines to one blank line (paragraph break kept)', () => {
    expect(cleanOcrText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('leaves Persian text, Persian digits, URLs and punctuation untouched', () => {
    const raw = 'سلام دنیا! شماره ۱۲۳۴۵ و 67890';
    expect(cleanOcrText(`  ${raw}  `)).toBe(raw);
    expect(cleanOcrText('ببین https://example.com/a?b=1 ok')).toBe(
      'ببین https://example.com/a?b=1 ok',
    );
  });

  it('trims to empty for whitespace-only OCR output', () => {
    expect(cleanOcrText('   \n\t  \n')).toBe('');
  });
});

describe('file-ocr-child — countMeaningfulChars', () => {
  it('counts Latin letters, digits and Persian letters/digits', () => {
    expect(countMeaningfulChars('سلام')).toBe(4);
    expect(countMeaningfulChars('Hello123')).toBe(8);
    expect(countMeaningfulChars('۱۲۳')).toBe(3);
    expect(countMeaningfulChars('۶۷۸۹')).toBe(4);
  });

  it('does not count symbol noise', () => {
    expect(countMeaningfulChars('| + © — ~')).toBe(0);
    expect(countMeaningfulChars('')).toBe(0);
  });
});
