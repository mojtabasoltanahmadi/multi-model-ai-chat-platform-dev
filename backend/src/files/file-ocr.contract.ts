/**
 * Contract between the API process and the dedicated OCR child process
 * (`file-ocr-child.ts`). The child owns tesseract.js entirely: any crash or
 * hang inside tesseract's worker threads stays inside the child, which the
 * parent can always kill. Kept free of tesseract.js imports so the API
 * process never loads the library.
 */

/** One OCR task sent parent → child over the IPC channel. */
export interface OcrTask {
  language: string;
  buffer: Buffer;
  /** Existing, writable directory for tesseract's traineddata cache. */
  cachePath: string;
  /** Optional local tessdata directory / URL base (air-gapped installs). */
  langPath?: string;
  dataPath?: string;
}

/** Result sent child → parent: a clean outcome or the failure message. */
export type OcrOutcome =
  | { ok: true; text: string }
  | { ok: false; message: string };

/** Progress ping sent after tesseract's worker finished initializing. */
export interface OcrReady {
  ready: true;
}

/** Compiled filename of the child entry, forked from this directory. */
export const OCR_CHILD_FILENAME = 'file-ocr-child.js';
