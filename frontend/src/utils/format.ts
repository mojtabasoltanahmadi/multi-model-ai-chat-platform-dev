/** Persian-aware formatting helpers. */

const relativeFormatter = new Intl.RelativeTimeFormat('fa', { numeric: 'auto' });

/** «5 minute ago» / «yesterday» style label for sidebar conversation items. */
export function formatRelative(iso: string): string {
  const date = new Date(iso);
  const diffMinutes = Math.round((date.getTime() - Date.now()) / 60000);
  const abs = Math.abs(diffMinutes);

  if (abs < 1) return 'همین حالا';
  if (abs < 60) return relativeFormatter.format(diffMinutes, 'minute');
  if (abs < 60 * 24) return relativeFormatter.format(Math.round(diffMinutes / 60), 'hour');
  if (abs < 60 * 24 * 7) return relativeFormatter.format(Math.round(diffMinutes / (60 * 24)), 'day');
  return new Intl.DateTimeFormat('fa-IR', { day: 'numeric', month: 'long' }).format(date);
}

/** «14:32» for today's messages. */
export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );
}

/** «12 Farvardin، 14:32» for older messages. */
export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('fa-IR', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatFullDate(iso: string): string {
  return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' }).format(new Date(iso));
}

/**
 * Friendly first name for the empty-chat greeting, derived from the email
 * local part («ali9074@…» → «Ali», «sara.m@…» → «Sara»). Returns '' when no
 * usable name fragment exists, so callers can fall back to a generic greeting.
 * Persian local parts are returned untouched; Latin ones get a capital.
 */
export function displayNameFromEmail(email: string | null | undefined): string {
  if (!email) return '';
  const local = email.split('@')[0] ?? '';
  const firstFragment = local.replace(/[0-9._-]+/g, ' ').trim().split(/\s+/)[0] ?? '';
  if (firstFragment.length < 2) return '';
  const head = Array.from(firstFragment)[0]!;
  return /[A-Za-z]/.test(head) ? head.toUpperCase() + firstFragment.slice(1) : firstFragment;
}
