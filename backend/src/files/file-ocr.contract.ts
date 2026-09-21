/**
 * Contract between the API process and the dedicated OCR child process
 * (`file-ocr-child.ts`). The child owns tesseract.js AND the sharp
 * preprocessing entirely: any crash, hang, or native-memory spike stays
 * inside the child, which the parent can always kill. Kept free of
 * tesseract.js/sharp imports so the API process never loads those libraries.
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
  /**
   * Primary Tesseract page-segmentation mode (tesseract.js PSM value as a
   * number, e.g. 6 = single uniform block). Unset ⇒ child default (6).
   */
  psm?: number;
}

/** How the child actually processed the image (observability for the logs). */
export interface OcrMeta {
  /** Dimensions after preprocessing (what Tesseract saw). */
  width: number;
  height: number;
  /** Preprocessing strategy of the winning pass: normal | threshold. */
  strategy: PreprocessStrategyName;
  /** OCR passes used (1 = primary only; 2 = fallback also ran). */
  passes: number;
}

type PreprocessStrategyName = 'normal' | 'threshold';

/** Result sent child → parent: a clean outcome or the failure message. */
export type OcrOutcome =
  | { ok: true; text: string; meta: OcrMeta }
  | { ok: false; message: string };

/** Progress ping sent after tesseract's worker finished initializing. */
export interface OcrReady {
  ready: true;
}

/** Compiled filename of the child entry, forked from this directory. */
export const OCR_CHILD_FILENAME = 'file-ocr-child.js';
