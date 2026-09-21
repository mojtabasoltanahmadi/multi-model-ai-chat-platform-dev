import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { fork } from 'child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { InvalidPDFException, PDFParse, PasswordException } from 'pdf-parse';
import { FileKind } from './file-validation';
import {
  OCR_CHILD_FILENAME,
  OcrOutcome,
  OcrReady,
  OcrTask,
} from './file-ocr.contract';

/**
 * Error classes distinguishing transient failures (storage/network hiccups —
 * worth a BullMQ retry) from permanent ones (corrupt/unsupported content —
 * retrying can never succeed). The processor maps these to FAILED
 * (unrecoverable) versus retry-then-FAILED.
 */
export class PermanentExtractionError extends Error {}

/** Optional per-job observability context threaded from the queue processor. */
export interface ExtractionContext {
  fileId?: string;
  jobId?: string;
  attempt?: number;
}

/**
 * tesseract.js reports worker-side failures as plain strings (err.toString()),
 * so transport-level trouble is told apart from content-level failure by
 * message inspection. Transport failures (language-data download, engine init)
 * are transient: BullMQ should retry them; anything else means the image
 * itself could not be processed and retrying can never succeed.
 */
const TRANSIENT_OCR_PATTERN =
  /fetch failed|Network error while fetching|initialization failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|UND_ERR|socket hang up|aborted/i;

function isTransientOcrFailure(message: string): boolean {
  return TRANSIENT_OCR_PATTERN.test(message);
}

/** Normalized successful extraction result. */
export interface ExtractionResult {
  text: string;
}

/**
 * Extraction pipelines for the three MVP kinds:
 *   pdf   → pdf-parse text extraction (page-labeled)
 *   excel → xlsx sheet serialization (Sheet | Name|Age|City table style)
 *   image → tesseract.js OCR run inside a dedicated child process (see
 *           file-ocr-child.ts for why tesseract must never run in the API
 *           process)
 *
 * Every extractor throws PermanentExtractionError for content-level failure
 * (corrupt pdf, unreadable workbook, OCR finding nothing) and lets transport
 * errors (storage/network) bubble as-is so BullMQ can retry them.
 */
@Injectable()
export class FileExtractionService {
  private readonly logger = new Logger(FileExtractionService.name);
  private readonly ocrLanguage: string;
  /** Keeps tesseract's language-data cache out of the repository. */
  private readonly ocrCachePath: string;
  /** Optional local tessdata directory for air-gapped installs. */
  private readonly ocrDataPath: string;
  /** Primary Tesseract page-segmentation mode (see file-ocr-child.ts). */
  private readonly ocrPsm: number;
  /** Hard budget for one OCR attempt; the child is killed after it. */
  private readonly ocrTimeoutMs: number;

  constructor(configService: ConfigService) {
    // fas+eng: the product is Persian-first — the English-only default made
    // Tesseract read Persian glyphs as Latin garbage. Both datasets load
    // together; script choice happens per glyph inside the engine.
    this.ocrLanguage = configService.get<string>('ocr.language') ?? 'fas+eng';
    // Absolute paths: the OCR child (and tesseract's cache reads) must not
    // depend on whoever's CWD — a relative OCR_CACHE_PATH would silently
    // resolve differently per process on Windows.
    this.ocrCachePath = resolve(
      configService.get<string>('ocr.cachePath') || join(tmpdir(), 'ai-chat-ocr-cache'),
    );
    const dataPath = configService.get<string>('ocr.dataPath') ?? '';
    this.ocrDataPath = dataPath ? resolve(dataPath) : '';
    this.ocrPsm = configService.get<number>('ocr.psm') ?? 6;
    this.ocrTimeoutMs = configService.get<number>('ocr.timeoutMs') ?? 90_000;
  }

  async extract(
    kind: FileKind,
    buffer: Buffer,
    context: ExtractionContext = {},
  ): Promise<ExtractionResult> {
    switch (kind) {
      case 'pdf':
        return this.extractPdf(buffer);
      case 'excel':
        return this.extractExcel(buffer);
      case 'image':
        return this.extractImageOcr(buffer, context);
      default: {
        const exhaustive: never = kind;
        throw new PermanentExtractionError(`نوع فایل پشتیبانی نمی‌شود: ${String(exhaustive)}`);
      }
    }
  }

  // ---- PDF ----

  private async extractPdf(buffer: Buffer): Promise<ExtractionResult> {
    let parser: PDFParse | null = null;
    try {
      parser = new PDFParse({ data: new Uint8Array(buffer) });
      const result = await parser.getText();
      const pages = (result.pages ?? [])
        .map((page: { num: number; text: string }) => `— صفحه ${page.num} —\n${page.text.trim()}`)
        .filter((section: string) => section.replace(/^— صفحه \d+ —\n?/, '').trim().length > 0);

      const text = pages.join('\n\n').trim();
      if (!text) {
        // An image-only / scanned PDF with no extractable text layer must
        // FAIL explicitly — never pretend success with empty content.
        throw new PermanentExtractionError(
          'متنی از این PDF قابل استخراج نیست (احتمالاً اسکن‌شده یا تصویری است).',
        );
      }
      return { text };
    } catch (error) {
      if (error instanceof PermanentExtractionError) throw error;
      // Corrupt or password-protected PDFs are content-level failures: no
      // amount of retrying makes them extractable.
      if (error instanceof InvalidPDFException || error instanceof PasswordException) {
        throw new PermanentExtractionError(
          error instanceof PasswordException
            ? 'این PDF رمزنگاری شده است و قابل پردازش نیست.'
            : 'فایل PDF خراب است یا قابل خواندن نیست.',
        );
      }
      throw error; // unknown → treat as transient (retry)
    } finally {
      await parser?.destroy().catch(() => undefined);
    }
  }

  // ---- Excel ----

  private async extractExcel(buffer: Buffer): Promise<ExtractionResult> {
    // Guard before parsing: SheetJS happily parses arbitrary text as CSV, so
    // without this check a mislabelled text file would "extract" successfully.
    // Real workbooks are either a zip container (xlsx) or an OLE2 container (.xls).
    const isZip = buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const isOle2 = buffer.subarray(0, 8).equals(
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    );
    if (!isZip && !isOle2) {
      throw new PermanentExtractionError('فایل Excel خراب است یا قابل خواندن نیست.');
    }

    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buffer, { type: 'buffer' });
    } catch {
      throw new PermanentExtractionError('فایل Excel خراب است یا قابل خواندن نیست.');
    }

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new PermanentExtractionError('این فایل Excel هیچ شیتی ندارد.');
    }

    const sections: string[] = [];
    let totalRows = 0;
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        blankrows: false,
        defval: '',
        raw: false,
      });
      if (rows.length === 0) {
        sections.push(`Sheet: ${sheetName}\n(این شیت خالی است)`);
        continue;
      }
      totalRows += rows.length;
      const rendered = rows
        .map((row) =>
          (row as unknown[])
            .map((cell) => (cell === null || cell === undefined ? '' : String(cell).trim()))
            .join(' | '),
        )
        .join('\n');
      sections.push(`Sheet: ${sheetName}\n${rendered}`);
    }

    const text = sections.join('\n\n').trim();
    if (!text || totalRows === 0) {
      throw new PermanentExtractionError('این فایل Excel هیچ داده قابل استخراجی ندارد.');
    }
    return { text };
  }

  // ---- Image / OCR ----

  private async extractImageOcr(
    buffer: Buffer,
    context: ExtractionContext = {},
  ): Promise<ExtractionResult> {
    // tesseract.js runs in a dedicated child process: a crash inside its
    // worker threads or a hang in createWorker must never take down (or wedge)
    // the API process. See file-ocr-child.ts for the failure modes contained.
    const tag = this.ocrLogTag(context);
    const startedAt = Date.now();
    this.logger.log(
      `file.ocr.start ${tag} language=${this.ocrLanguage} psm=${this.ocrPsm} bytes=${buffer.length}`,
    );

    this.ensureOcrCacheDir();

    const child = fork(join(__dirname, OCR_CHILD_FILENAME), [], {
      serialization: 'advanced',
      stdio: 'inherit',
    });

    return new Promise<ExtractionResult>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error: Error | null, result?: ExtractionResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        // Exactly one task per child — always release it, also on
        // failure/timeout, so a stuck OCR can neither wedge the queue nor
        // leak a process.
        child.kill();
        if (error) {
          reject(error);
        } else {
          resolve(result as ExtractionResult);
        }
      };

      // Bounds everything: engine boot, language-data download, recognition.
      timer = setTimeout(() => {
        this.logger.warn(`file.ocr.timeout ${tag} timeoutMs=${this.ocrTimeoutMs}`);
        finish(new Error(`OCR timed out after ${this.ocrTimeoutMs}ms`));
      }, this.ocrTimeoutMs);

      child.on('message', (message: OcrOutcome | OcrReady) => {
        if (!message || typeof message !== 'object' || !('ok' in message)) {
          this.logger.log(`file.ocr.worker_created ${tag} bootMs=${Date.now() - startedAt}`);
          return;
        }
        if (message.ok) {
          // The child returns already-cleaned text (conservative whitespace
          // normalization only — characters are untouched).
          const text = message.text ?? '';
          const meta = message.meta ?? { width: 0, height: 0, strategy: '-', passes: 0 };
          this.logger.log(
            `file.ocr.completed ${tag} chars=${text.length} ` +
              `dims=${meta.width}x${meta.height} strategy=${meta.strategy} passes=${meta.passes} ` +
              `durationMs=${Date.now() - startedAt}`,
          );
          if (!text.trim()) {
            finish(
              new PermanentExtractionError(
                'متنی در این تصویر شناسایی نشد (تصویر ممکن است فاقد متن باشد).',
              ),
            );
          } else {
            finish(null, { text });
          }
          return;
        }
        const reason = message.message || 'unknown OCR failure';
        if (isTransientOcrFailure(reason)) {
          // Transport-level (language-data download / engine init): let the
          // error bubble as transient so BullMQ retries per its policy.
          this.logger.warn(`file.ocr.failed_transient ${tag} reason=${reason}`);
          finish(new Error(`OCR failed: ${reason}`));
        } else {
          // Content-level (e.g. undecodable image): retrying never succeeds.
          this.logger.warn(`file.ocr.failed_permanent ${tag} reason=${reason}`);
          finish(new PermanentExtractionError('پردازش OCR روی این تصویر ممکن نشد.'));
        }
      });
      child.on('error', (error) => {
        this.logger.warn(`file.ocr.child_error ${tag} reason=${error.message}`);
        finish(new Error(`OCR worker process failed: ${error.message}`));
      });
      child.on('exit', (code, signal) => {
        if (!settled) {
          this.logger.warn(`file.ocr.child_died ${tag} code=${code} signal=${signal}`);
          finish(
            new Error(`OCR worker process died unexpectedly (code=${code} signal=${signal})`),
          );
        }
      });

      const task: OcrTask = {
        language: this.ocrLanguage,
        buffer,
        cachePath: this.ocrCachePath,
        psm: this.ocrPsm,
      };
      if (this.ocrDataPath) {
        task.langPath = this.ocrDataPath;
        task.dataPath = this.ocrDataPath;
      }
      child.send(task, (error) => {
        if (error) {
          this.logger.warn(`file.ocr.send_failed ${tag} reason=${error.message}`);
          finish(new Error(`OCR worker process failed: ${error.message}`));
        }
      });
    });
  }

  /** tesseract.js never creates the cache directory itself; a missing dir makes
   * the silently-failing cache write re-download language data on every OCR. */
  private ensureOcrCacheDir(): void {
    try {
      mkdirSync(this.ocrCachePath, { recursive: true });
    } catch (error) {
      this.logger.warn(
        `file.ocr.cache_dir_unavailable path=${this.ocrCachePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private ocrLogTag(context: ExtractionContext): string {
    return `fileId=${context.fileId ?? '-'} jobId=${context.jobId ?? '-'} attempt=${context.attempt ?? '-'}`;
  }
}
