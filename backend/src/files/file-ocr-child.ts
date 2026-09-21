import { createWorker } from 'tesseract.js';
import type { OcrOutcome, OcrTask } from './file-ocr.contract';

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
 */

export async function runOcrTask(
  task: OcrTask,
  onReady?: () => void,
): Promise<OcrOutcome> {
  try {
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
      const { data } = await worker.recognize(task.buffer);
      return { ok: true, text: data.text ?? '' };
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

/** IPC entry point when forked: exactly one task per child. */
if (require.main === module) {
  // The parent owns our lifetime; if the IPC channel drops, exit instead of
  // idling with the wasm engine resident.
  process.on('disconnect', () => process.exit(0));
  process.on('message', (task: OcrTask) => {
    if (!task || typeof task !== 'object' || !('buffer' in task)) return;
    runOcrTask(task, () => process.send?.({ ready: true } satisfies { ready: true }))
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
