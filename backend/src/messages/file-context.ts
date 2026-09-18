import type { AttachedFileContext } from '../files/files.service';

/** Appended when a file's text does not fit the context budget. */
export const CONTEXT_TRUNCATION_NOTE = '\n[…] متن این فایل به دلیل حجم زیاد کوتاه شد.]';

const CONTEXT_HEADER = '[محتوای فایل‌های پیوست‌شده]';
const CONTEXT_FOOTER = '[/محتوای فایل‌های پیوست‌شده]';

/**
 * Builds the prompt content for a user turn with attached files.
 *
 * Context protection (Section 26): the total attached text never exceeds
 * `maxContextChars`. The budget is split evenly across the attached files, so
 * one huge file cannot starve the others, and every truncated file carries an
 * explicit note — a silently shortened context would mislead the model's
 * answer. When there are no attachments the user's text is returned verbatim,
 * so the no-file path is byte-identical to the pre-feature behaviour.
 */
export function buildContextualPrompt(
  attachments: AttachedFileContext[],
  userContent: string,
  maxContextChars: number,
): string {
  if (attachments.length === 0) return userContent;

  const budget = Math.max(Math.floor(maxContextChars), 0);
  const perFile = Math.max(Math.floor(budget / attachments.length), 0);

  const blocks = attachments.map((file) => {
    const text = (file.extractedText ?? '').trim();
    const truncated = text.length > perFile;
    const body = truncated ? text.slice(0, perFile) : text;
    return [
      `--- فایل: ${file.originalName} (${file.mimeType}) ---`,
      body,
      truncated ? CONTEXT_TRUNCATION_NOTE.trim() : '',
      `--- پایان فایل: ${file.originalName} ---`,
    ]
      .filter((line) => line.length > 0)
      .join('\n');
  });

  return [CONTEXT_HEADER, ...blocks, CONTEXT_FOOTER, '', userContent].join('\n\n');
}
