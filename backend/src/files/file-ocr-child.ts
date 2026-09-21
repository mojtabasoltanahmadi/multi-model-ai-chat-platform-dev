import { createWorker, PSM } from 'tesseract.js';
import { preprocessForOcr } from './ocr-preprocess';
import type { OcrMeta, OcrOutcome, OcrTask } from './file-ocr.contract';

/**
 * Runs inside a dedicated child process forked by FileExtractionService.
 *
 * Tesseract.js v7 must never run in the API process: on any worker rejection
 * its message handler does `throw Error(data)` inside the worker's message
 * listener (src/createWorker.js:217), which Node escalates to an
 * uncaughtException and kills the whole process; and when language-data
 * loading fails, createWorker's returned promise never settles (the rejection
 * is swallowed internally), which would leak an un-terminatable worker thread.
 * Both failure modes are contained here — the child either reports a clean
 * outcome over IPC or dies, and the parent always releases the child.
 *
 * OCR flow (one worker, at most two recognition passes):
 *   preprocess (sharp, strategy `normal`)
 *     → setParameters(psm = configured primary, default SINGLE_BLOCK)
 *     → recognize
 *     → if the text has (almost) no meaningful characters:
 *         preprocess (strategy `threshold`) + setParameters(SPARSE_TEXT)
 *         → recognize again on the SAME worker
 *   The better result wins; the worker is terminated in `finally` on every
 *   path. The second pass is the only fallback — no strategy matrix.
 */

/** Primary PSM when the task does not carry one: treat the image as one
 * uniform text block — robust for chat uploads (documents, screenshots of a
 * region, photos of text), unlike the core default (AUTO layout analysis)
 * which mis-segments sparse UI text. */
const DEFAULT_PRIMARY_PSM: PSM = PSM.SINGLE_BLOCK;
/** Fallback PSM: find scattered words/labels (sparse screenshot text). */
const FALLBACK_PSM: PSM = PSM.SPARSE_TEXT;
/** Fewer meaningful characters than this in the primary pass ⇒ try fallback. */
const MIN_MEANINGFUL_CHARS = 4;

export async function runOcrTask(
  task: OcrTask,
  onReady?: () => void,
): Promise<OcrOutcome> {
  let meta: OcrMeta = { width: 0, height: 0, strategy: 'normal', passes: 0 };
  try {
    // ---- preprocessing (sharp) ----
    let preprocessed: Awaited<ReturnType<typeof preprocessForOcr>>;
    try {
      preprocessed = await preprocessForOcr(task.buffer, 'normal');
    } catch (error) {
      // Corrupt/truncated/undecodable image: content-level, never retryable.
      return {
        ok: false,
        message: `unsupported or corrupted image: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    meta = {
      width: preprocessed.width,
      height: preprocessed.height,
      strategy: 'normal',
      passes: 0,
    };

    // ---- worker lifecycle: create → configure → recognize → terminate ----
    const options: Record<string, unknown> = {
      cachePath: task.cachePath,
      // Required: without it tesseract throws inside its message listener on
      // every worker rejection (uncaughtException for this process).
      errorHandler: () => undefined,
    };
    // Only forward data-path options when configured — empty strings would be
    // passed to tesseract as-is.
    if (task.langPath) {
      options.langPath = task.langPath;
      options.dataPath = task.dataPath;
    }

    const worker = await createWorker(task.language, undefined, options);
    onReady?.();
    try {
      const primaryPsm = task.psm !== undefined ? (String(task.psm) as PSM) : DEFAULT_PRIMARY_PSM;

      await worker.setParameters({ tessedit_pageseg_mode: primaryPsm });
      const primary = await worker.recognize(preprocessed.buffer);
      meta.passes = 1;

      let text = cleanOcrText(primary.data.text ?? '');
      if (countMeaningfulChars(text) >= MIN_MEANINGFUL_CHARS) {
        return { ok: true, text, meta };
      }

      // Primary found (almost) nothing — one bounded fallback with a
      // binarized image and sparse-text segmentation on the same worker.
      const fallbackImage = await preprocessForOcr(task.buffer, 'threshold');
      await worker.setParameters({ tessedit_pageseg_mode: FALLBACK_PSM });
      const fallback = await worker.recognize(fallbackImage.buffer);
      meta.passes = 2;

      const fallbackText = cleanOcrText(fallback.data.text ?? '');
      if (countMeaningfulChars(fallbackText) > countMeaningfulChars(text)) {
        text = fallbackText;
        meta = { ...meta, strategy: 'threshold', width: fallbackImage.width, height: fallbackImage.height };
      }
      return { ok: true, text, meta };
    } finally {
      await worker.terminate().catch(() => undefined);
    }
  } catch (error) {
    // tesseract reports worker-side failures as plain strings (err.toString());
    // they must become a structured outcome, never an escaping exception.
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Counts characters OCR could plausibly have read right: Latin letters,
 * digits, and Arabic/Persian-script letters. Whitespace, punctuation and
 * symbol noise do not count — a pass producing only "| + ©" noise is empty
 * for fallback purposes.
 */
export function countMeaningfulChars(text: string): number {
  const matches = text.match(/[a-zA-Z0-9\u0621-\u064A\u0660-\u0669\u06F0-\u06F9]/g);
  return matches ? matches.length : 0;
}

/**
 * Conservative OCR-output cleanup: normalizes line endings, drops the form
 * feed Tesseract emits per page, trims trailing per-line whitespace, collapses
 * runs of spaces/tabs (OCR double-space noise) and of blank lines, and trims
 * the ends. Deliberately does NOT touch characters — Persian/Arabic script,
 * numerals (Latin and Persian), URLs, punctuation and RTL ordering must all
 * survive exactly as recognized.
 */
export function cleanOcrText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** IPC entry point when forked: exactly one task per child. */
if (require.main === module) {
  // The parent owns our lifetime; if the IPC channel drops, exit instead of
  // idling with the wasm engine resident.
  process.on('disconnect', () => process.exit(0));
  process.on('message', (task: OcrTask) => {
    if (!task || typeof task !== 'object' || !('buffer' in task)) return;
    runOcrTask(task, () => process.send?.({ ready: true }))
      .then((outcome) => {
        process.send?.(outcome);
      })
      .catch((error: unknown) => {
        process.send?.({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  });
}
