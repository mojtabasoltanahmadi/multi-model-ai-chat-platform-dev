import { createWorker } from 'tesseract.js';
import { runOcrTask } from './file-ocr-child';
import type { OcrTask } from './file-ocr.contract';

/**
 * tesseract.js is mocked; the real engine is covered end-to-end by
 * scripts/file-processing-test.mjs against a running stack. These tests pin
 * the child-side contract: an errorHandler MUST be registered (tesseract.js
 * v7 otherwise throws inside its worker message listener — the uncaught
 * exception that killed the API process before OCR was isolated), data-path
 * options are only forwarded when configured, and every failure becomes a
 * structured { ok: false } outcome instead of an escaping exception.
 */
jest.mock('tesseract.js', () => ({ createWorker: jest.fn() }));

const mockCreateWorker = createWorker as unknown as jest.Mock;

function makeTask(overrides: Partial<OcrTask> = {}): OcrTask {
  return {
    language: 'eng',
    buffer: Buffer.from('fake-png'),
    cachePath: '/cache',
    ...overrides,
  };
}

function stubWorker(recognizeImpl: jest.Mock): { terminate: jest.Mock } {
  const terminate = jest.fn().mockResolvedValue(undefined);
  mockCreateWorker.mockResolvedValue({ recognize: recognizeImpl, terminate });
  return { terminate };
}

describe('file-ocr-child — runOcrTask', () => {
  beforeEach(() => mockCreateWorker.mockReset());

  it('registers an errorHandler and cachePath, without data-path options when unset', async () => {
    stubWorker(jest.fn().mockResolvedValue({ data: { text: 'hi' } }));

    await runOcrTask(makeTask());

    expect(mockCreateWorker).toHaveBeenCalledWith('eng', undefined, expect.any(Object));
    const options = mockCreateWorker.mock.calls[0][2] as Record<string, unknown>;
    expect(options.cachePath).toBe('/cache');
    expect(options.errorHandler).toBeInstanceOf(Function);
    expect(options.langPath).toBeUndefined();
    expect(options.dataPath).toBeUndefined();
  });

  it('forwards langPath/dataPath only when the task carries them', async () => {
    stubWorker(jest.fn().mockResolvedValue({ data: { text: 'hi' } }));

    await runOcrTask(makeTask({ langPath: 'D:/tessdata', dataPath: 'D:/tessdata' }));

    const options = mockCreateWorker.mock.calls[0][2] as Record<string, unknown>;
    expect(options.langPath).toBe('D:/tessdata');
    expect(options.dataPath).toBe('D:/tessdata');
  });

  it('does not throw when tesseract invokes the errorHandler (crash suppression)', async () => {
    stubWorker(jest.fn().mockResolvedValue({ data: { text: 'hi' } }));

    await runOcrTask(makeTask());

    const options = mockCreateWorker.mock.calls[0][2] as Record<string, unknown>;
    expect(() => (options.errorHandler as (m: unknown) => void)('worker blew up')).not.toThrow();
  });

  it('reports the recognized text and terminates the worker', async () => {
    const { terminate } = stubWorker(jest.fn().mockResolvedValue({ data: { text: ' hi ' } }));

    const outcome = await runOcrTask(makeTask());

    expect(outcome).toEqual({ ok: true, text: ' hi ' });
    expect(terminate).toHaveBeenCalled();
  });

  it('reports recognition failures as a structured outcome and still terminates', async () => {
    const { terminate } = stubWorker(jest.fn().mockRejectedValue(new Error('wasm blew up')));

    const outcome = await runOcrTask(makeTask());

    expect(outcome).toEqual({ ok: false, message: 'wasm blew up' });
    expect(terminate).toHaveBeenCalled();
  });

  it('reports createWorker failures (e.g. string fetch rejections) as a structured outcome', async () => {
    const terminate = jest.fn().mockResolvedValue(undefined);
    // tesseract rejections arrive as plain strings (err.toString()).
    mockCreateWorker.mockRejectedValue('TypeError: fetch failed');

    const outcome = await runOcrTask(makeTask());

    expect(outcome).toEqual({ ok: false, message: 'TypeError: fetch failed' });
    expect(terminate).not.toHaveBeenCalled();
  });

  it('signals readiness after the worker finished initializing', async () => {
    stubWorker(jest.fn().mockResolvedValue({ data: { text: 'hi' } }));
    const onReady = jest.fn();

    await runOcrTask(makeTask(), onReady);

    expect(onReady).toHaveBeenCalledTimes(1);
  });
});
