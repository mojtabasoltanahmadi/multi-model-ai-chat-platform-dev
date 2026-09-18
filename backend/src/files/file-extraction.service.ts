import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { InvalidPDFException, PDFParse, PasswordException } from 'pdf-parse';
import { createWorker } from 'tesseract.js';
import { FileKind } from './file-validation';

/**
 * Error classes distinguishing transient failures (storage/network hiccups —
 * worth a BullMQ retry) from permanent ones (corrupt/unsupported content —
 * retrying can never succeed). The processor maps these to FAILED
 * (unrecoverable) versus retry-then-FAILED.
 */
export class PermanentExtractionError extends Error {}

/** Normalized successful extraction result. */
export interface ExtractionResult {
  text: string;
}

/**
 * Extraction pipelines for the three MVP kinds:
 *   pdf   → pdf-parse text extraction (page-labeled)
 *   excel → xlsx sheet serialization (Sheet | Name|Age|City table style)
 *   image → tesseract.js OCR (pure JS; works without native deps)
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

  constructor(configService: ConfigService) {
    this.ocrLanguage = configService.get<string>('ocr.language') ?? 'eng';
    this.ocrCachePath =
      configService.get<string>('ocr.cachePath') || join(tmpdir(), 'ai-chat-ocr-cache');
    this.ocrDataPath = configService.get<string>('ocr.dataPath') || '';
  }

  async extract(kind: FileKind, buffer: Buffer): Promise<ExtractionResult> {
    switch (kind) {
      case 'pdf':
        return this.extractPdf(buffer);
      case 'excel':
        return this.extractExcel(buffer);
      case 'image':
        return this.extractImageOcr(buffer);
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

  private async extractImageOcr(buffer: Buffer): Promise<ExtractionResult> {
    // tesseract.js accepts image Buffers directly (pure-JS decoders; no
    // canvas/native deps). Language data is cached in a temp dir; an offline
    // deployment can point OCR_DATA_PATH at a local tessdata directory.
    let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
    try {
      const options: Record<string, unknown> = { cachePath: this.ocrCachePath };
      if (this.ocrDataPath) {
        options.langPath = this.ocrDataPath;
        options.dataPath = this.ocrDataPath;
      }
      worker = await createWorker(this.ocrLanguage, undefined, options);
      const { data } = await worker.recognize(buffer);
      const text = (data.text ?? '').replace(/[ \t]+\n/g, '\n').trim();
      if (!text) {
        throw new PermanentExtractionError(
          'متنی در این تصویر شناسایی نشد (تصویر ممکن است فاقد متن باشد).',
        );
      }
      return { text };
    } catch (error) {
      if (error instanceof PermanentExtractionError) throw error;
      this.logger.warn(
        `OCR failed (${error instanceof Error ? error.message : String(error)})`,
      );
      throw new PermanentExtractionError('پردازش OCR روی این تصویر ممکن نشد.');
    } finally {
      await worker?.terminate().catch(() => undefined);
    }
  }
}
