import sharp from 'sharp';

/**
 * Image preprocessing for OCR, run inside the OCR child process so the
 * native-image memory stays out of the API process (same isolation rationale
 * as tesseract itself — see file-ocr-child.ts).
 *
 * Two strategies, one primary and one fallback (never more):
 *
 *  `normal`    — upscale small images / cap huge ones, grayscale, normalize
 *                contrast, mild sharpen. The default for every image:
 *                Tesseract needs roughly ≥30px glyph height, so screenshots
 *                and small text must be enlarged, and grayscale+normalize
 *                remove the color/background variance the LSTM dislikes.
 *  `threshold` — same sizing + grayscale + normalize, then hard binarization.
 *                The fallback for faint/low-contrast text or noisy
 *                backgrounds where soft gradients confuse segmentation.
 */

/** Widths chosen for Tesseract's sweet spot (~300 DPI equivalent text). */
const SMALL_WIDTH_THRESHOLD = 1000;
const UPSCALE_TARGET_WIDTH = 2000;
const MAX_WIDTH = 2400;
/** Cap on upscaling factor — 4× is plenty; beyond that is pure interpolation. */
const MAX_UPSCALE_FACTOR = 4;
const THRESHOLD_VALUE = 160;

export type PreprocessStrategy = 'normal' | 'threshold';

export interface PreprocessResult {
  buffer: Buffer;
  /** Dimensions AFTER preprocessing (what Tesseract actually sees). */
  width: number;
  height: number;
}

/** Picks the output width for an input width: upscale small, cap large. */
export function chooseTargetWidth(inputWidth: number): number | null {
  if (inputWidth < SMALL_WIDTH_THRESHOLD) {
    return Math.min(UPSCALE_TARGET_WIDTH, inputWidth * MAX_UPSCALE_FACTOR);
  }
  if (inputWidth > MAX_WIDTH) {
    return MAX_WIDTH;
  }
  return null; // already in the good range — no resize
}

/**
 * Prepares an uploaded image for OCR. Throws on images sharp cannot decode
 * (corrupt/truncated/unsupported) — the caller maps that to a permanent
 * extraction failure.
 */
export async function preprocessForOcr(
  input: Buffer,
  strategy: PreprocessStrategy = 'normal',
): Promise<PreprocessResult> {
  const image = sharp(input, { failOn: 'error' });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('image has no decodable dimensions');
  }

  const targetWidth = chooseTargetWidth(metadata.width);
  let pipeline = targetWidth
    ? image.resize({ width: targetWidth, kernel: 'lanczos3' })
    : image;

  pipeline = pipeline.grayscale().normalize();
  if (strategy === 'normal') {
    pipeline = pipeline.sharpen();
  } else {
    pipeline = pipeline.threshold(THRESHOLD_VALUE);
  }

  const { data, info } = await pipeline
    .toColourspace('b-w') // explicit grey bands (grayscale() alone keeps RGBA)
    .png()
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}
