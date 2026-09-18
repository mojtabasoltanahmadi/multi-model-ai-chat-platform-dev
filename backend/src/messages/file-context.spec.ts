import { buildContextualPrompt, CONTEXT_TRUNCATION_NOTE } from './file-context';
import type { AttachedFileContext } from '../files/files.service';

function attachment(overrides: Partial<AttachedFileContext> = {}): AttachedFileContext {
  return {
    id: 'file-1',
    originalName: 'report.pdf',
    mimeType: 'application/pdf',
    extractedText: 'FACT: the answer is 42',
    ...overrides,
  };
}

describe('buildContextualPrompt', () => {
  it('returns the user text untouched when nothing is attached', () => {
    expect(buildContextualPrompt([], 'سلام', 24000)).toBe('سلام');
  });

  it('injects the file name and content before the question', () => {
    const prompt = buildContextualPrompt([attachment()], 'این فایل درباره چیست؟', 24000);

    expect(prompt).toContain('report.pdf');
    expect(prompt).toContain('FACT: the answer is 42');
    expect(prompt.indexOf('FACT: the answer is 42')).toBeLessThan(
      prompt.indexOf('این فایل درباره چیست؟'),
    );
  });

  it('includes every attached file, each labeled', () => {
    const prompt = buildContextualPrompt(
      [
        attachment({ id: 'a', originalName: 'a.pdf', extractedText: 'content-a' }),
        attachment({ id: 'b', originalName: 'b.xlsx', extractedText: 'content-b' }),
      ],
      'سؤال',
      24000,
    );

    expect(prompt).toContain('content-a');
    expect(prompt).toContain('content-b');
    expect(prompt).toContain('a.pdf');
    expect(prompt).toContain('b.xlsx');
  });

  it('bounds the total context and marks truncation explicitly', () => {
    const huge = 'x'.repeat(10_000);
    const prompt = buildContextualPrompt(
      [attachment({ extractedText: huge })],
      'سؤال',
      1000,
    );

    // Budget respected (plus the fixed labels/notes).
    expect(prompt.length).toBeLessThan(1000 + 400);
    expect(prompt).toContain(CONTEXT_TRUNCATION_NOTE.trim());
    expect(prompt).toContain('سؤال');
  });

  it('splits the budget evenly so one huge file cannot starve another', () => {
    const prompt = buildContextualPrompt(
      [
        attachment({ id: 'a', originalName: 'a.pdf', extractedText: 'A'.repeat(5000) }),
        attachment({ id: 'b', originalName: 'b.pdf', extractedText: 'B'.repeat(100) }),
      ],
      'سؤال',
      2000,
    );

    // Both files are represented; the small one is intact in full.
    expect(prompt).toContain('B'.repeat(100));
    expect(prompt).toContain('a.pdf');
    expect(prompt).toContain('A'.repeat(100));
  });

  it('handles a file with no extracted text without breaking the prompt', () => {
    const prompt = buildContextualPrompt(
      [attachment({ extractedText: '' })],
      'سؤال',
      24000,
    );

    expect(prompt).toContain('report.pdf');
    expect(prompt).toContain('سؤال');
    expect(prompt).not.toContain(CONTEXT_TRUNCATION_NOTE.trim());
  });
});
