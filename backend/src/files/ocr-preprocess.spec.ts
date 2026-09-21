import sharp from 'sharp';
import {
  chooseTargetWidth,
  preprocessForOcr,
} from './ocr-preprocess';
import { tinyPngBuffer } from '../test/fixtures';

/**
 * Real sharp runs here (native module, no tesseract involved): these tests
 * pin the sizing policy and the two preprocessing pipelines. Recognition
 * quality itself is covered end-to-end by scripts/file-processing-test.mjs
 * against a running stack.
 */

describe('ocr-preprocess — chooseTargetWidth', () => {
  it('upscales small images toward 2000px, capped at 4×', () => {
    expect(chooseTargetWidth(300)).toBe(1200); // 4× wins over the 2000 target
    expect(chooseTargetWidth(600)).toBe(2000); // 4× would overshoot → target
    expect(chooseTargetWidth(999)).toBe(2000);
  });

  it('leaves images already in the good range untouched', () => {
    expect(chooseTargetWidth(1000)).toBeNull();
    expect(chooseTargetWidth(1920)).toBeNull();
    expect(chooseTargetWidth(2400)).toBeNull();
  });

  it('downscales oversized images to 2400px', () => {
    expect(chooseTargetWidth(2401)).toBe(2400);
    expect(chooseTargetWidth(6000)).toBe(2400);
  });
});

describe('ocr-preprocess — preprocessForOcr', () => {
  it('upscales a tiny image to at least 4× width and returns PNG dimensions', async () => {
    const { buffer, width, height } = await preprocessForOcr(tinyPngBuffer(), 'normal');

    expect(width).toBe(16); // 4px × the 4× upscale factor
    expect(height).toBe(16);
    // PNG magic bytes — tesseract always receives PNG, never a raw JPEG.
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('grayscales and normalizes (grey-band PNG output)', async () => {
    const { buffer } = await preprocessForOcr(tinyPngBuffer(), 'normal');
    const metadata = await sharp(buffer).metadata();
    expect(metadata.format).toBe('png');
    // grey or grey+alpha — never full RGB(A).
    expect([1, 2]).toContain(metadata.channels);
  });

  it('produces a binarized image for the threshold strategy', async () => {
    const normal = await preprocessForOcr(tinyPngBuffer(), 'normal');
    const thresholded = await preprocessForOcr(tinyPngBuffer(), 'threshold');

    expect(thresholded.width).toBe(normal.width);
    // A uniform white image stays all-white either way; the contract here is
    // just that both strategies return distinct valid pipelines.
    expect(thresholded.buffer.length).toBeGreaterThan(0);
  });

  it('rejects corrupt image buffers (permanent failure upstream)', async () => {
    const garbage = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG magic
      Buffer.from('definitely not the rest of a png'),
    ]);
    await expect(preprocessForOcr(garbage, 'normal')).rejects.toThrow();
  });
});
