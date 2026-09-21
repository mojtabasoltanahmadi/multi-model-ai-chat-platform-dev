import type { ChatFile, Message } from '../api/types';

/**
 * Which of a conversation's files belong in the composer after a reload?
 *
 * A file is a DRAFT attachment until a persisted message references it —
 * consumption lives in `messages.attached_file_ids` (written by the backend
 * when the turn is sent), never in a frontend guess about status. That is
 * what makes both directions honest:
 *
 *   - a READY-but-unsent file is NOT referenced → it re-appears as a chip,
 *     so a refresh cannot make a file that was ready for sending vanish;
 *   - a file consumed by a sent message is referenced → it renders on its
 *     message row only, never again as a composer chip.
 *
 * Restored chips carry the persisted status (PROCESSING resumes polling,
 * FAILED shows its reason), so the server state — not memory — wins.
 */
export function draftFilesForRestore(
  files: ChatFile[],
  messages: Pick<Message, 'attachedFileIds'>[],
): ChatFile[] {
  const consumed = new Set(messages.flatMap((message) => message.attachedFileIds ?? []));
  return files.filter((file) => !consumed.has(file.id));
}
