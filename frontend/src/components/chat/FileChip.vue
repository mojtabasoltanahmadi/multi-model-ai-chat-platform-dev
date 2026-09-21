<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { formatBytes } from '../../utils/format';
import { fileKind } from '../../utils/fileKind';
import type { ChatFileStatus, FileUploadState } from '../../api/types';

interface Props {
  name: string;
  status: ChatFileStatus;
  /** Validated MIME type; drives the icon and the thumbnail decision. */
  mimeType?: string;
  /** Shown in the tooltip — the chip itself stays narrow. */
  size?: number;
  /** Safe backend reason, shown for FAILED files. */
  errorMessage?: string | null;
  /** Shows the remove button (composer chips only). */
  removable?: boolean;
  /** Opens the viewer when clicked (only meaningful for READY files). */
  clickable?: boolean;
  /**
   * Client-side upload state (composer chips only). Omitted for files restored
   * from history, where the server status is the only thing that matters.
   */
  upload?: FileUploadState | null;
  /** Upload failure reason (retryable), shown instead of the server message. */
  uploadError?: string | null;
  /** Object URL of an image thumbnail, when one is already available. */
  previewUrl?: string | null;
  /** Asks the parent to fetch a thumbnail lazily (images without a preview). */
  requestPreview?: () => void;
}

const props = withDefaults(defineProps<Props>(), {
  mimeType: '',
  size: 0,
  errorMessage: null,
  removable: false,
  clickable: false,
  upload: null,
  uploadError: null,
  previewUrl: null,
  requestPreview: undefined,
});

defineEmits<{ remove: []; open: []; retry: [] }>();

const kind = computed(() => fileKind({ originalName: props.name, mimeType: props.mimeType }));

/** A thumbnail only makes sense for images we can actually decode in a tag. */
const showThumbnail = computed(() => kind.value === 'image' && Boolean(props.previewUrl));

/**
 * One glyph carries the state: queued, working, uploaded (✓) or failed (✗).
 * Once the upload finished, the server lifecycle takes over — a file that later
 * fails extraction still shows the cross.
 */
const state = computed<'queued' | 'working' | 'done' | 'failed'>(() => {
  if (props.upload === 'pending') return 'queued';
  if (props.upload === 'error') return 'failed';
  if (props.upload === 'uploading') return 'working';
  if (props.upload === 'completed') return props.status === 'FAILED' ? 'failed' : 'done';
  if (props.status === 'READY') return 'done';
  if (props.status === 'FAILED') return 'failed';
  return 'working';
});

/**
 * A retry is offered for either failure stage: a client-side upload failure
 * can be re-sent from the File still in memory, and a FAILED server status
 * restarts extraction through the retry API (same file identity). Chips from
 * history pass no `upload`, so they never render a retry button.
 */
const canRetry = computed(
  () =>
    props.upload === 'error' ||
    (props.upload === 'completed' && props.status === 'FAILED'),
);

const retryLabel = computed(() =>
  props.upload === 'error'
    ? `تلاش دوباره برای آپلود ${props.name}`
    : `تلاش دوباره برای پردازش ${props.name}`,
);

/**
 * The words live in the tooltip and the accessible name only: the visible chip
 * is icon + truncated file name, so several files share one row.
 */
const stateLabel = computed(() => {
  switch (state.value) {
    case 'queued':
      return 'در انتظار آپلود';
    case 'working':
      return props.upload === 'uploading' ? 'در حال آپلود' : 'در حال پردازش';
    case 'done':
      return props.status === 'READY' ? 'آماده' : 'آپلود شد';
    default:
      return props.upload === 'error' ? 'آپلود ناموفق' : 'پردازش ناموفق';
  }
});

const errorText = computed(() => props.uploadError ?? props.errorMessage ?? '');

const title = computed(() => {
  const size = props.size > 0 ? formatBytes(props.size) : '';
  const parts = [props.name, size, stateLabel.value].filter(Boolean);
  if (errorText.value) parts.push(errorText.value);
  if (canRetry.value) parts.push('برای تلاش دوباره کلیک کنید');
  return parts.join(' — ');
});

/** Images restored from the server have no local preview yet — fetch on mount. */
onMounted(() => {
  if (kind.value === 'image' && !props.previewUrl && props.requestPreview) props.requestPreview();
});
</script>

<template>
  <span
    class="file-chip"
    :class="[`file-chip--${state}`, { 'file-chip--media': showThumbnail, 'file-chip--openable': clickable }]"
    role="status"
    :aria-label="title"
  >
    <component
      :is="clickable ? 'button' : 'span'"
      class="file-chip__main"
      :type="clickable ? 'button' : undefined"
      :title="title"
      @click="clickable && $emit('open')"
    >
      <img
        v-if="showThumbnail"
        class="file-chip__thumb"
        :src="previewUrl ?? undefined"
        alt=""
        loading="lazy"
      />
      <span v-else class="file-chip__icon">
        <svg
          v-if="kind === 'image'"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="m4 18 5-5 4 4 3-3 4 4" />
        </svg>
        <svg
          v-else-if="kind === 'sheet'"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 9h18M9 9v11M15 9v11" />
        </svg>
        <svg
          v-else
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
          <path d="M14 3v5h5" />
        </svg>
      </span>

      <span class="file-chip__name">{{ name }}</span>

      <!-- status: clock while queued, spinner while transferring, then ✓ / ✗ -->
      <span class="file-chip__state" aria-hidden="true">
        <svg
          v-if="state === 'queued'"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
        <span v-else-if="state === 'working'" class="file-chip__spinner"></span>
        <svg
          v-else-if="state === 'done'"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
        <svg
          v-else
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.4"
          stroke-linecap="round"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </span>
    </component>

    <button
      v-if="canRetry"
      type="button"
      class="file-chip__retry"
      :aria-label="retryLabel"
      :title="retryLabel"
      @click="$emit('retry')"
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M21 12a9 9 0 1 1-3-6.7" />
        <path d="M21 4v5h-5" />
      </svg>
    </button>

    <button
      v-if="removable"
      type="button"
      class="file-chip__remove"
      :aria-label="`حذف فایل ${name}`"
      :title="`حذف فایل ${name}`"
      @click="$emit('remove')"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  </span>
</template>

<style scoped>
/* Compact pill: several files fit on one row inside the composer. */
.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.18rem;
  max-width: 100%;
  /* Never squeeze: chips wrap onto the next row at their natural width, so a
     narrow panel keeps readable names instead of crushed pills. */
  flex: 0 0 auto;
  padding: 0.1rem 0.26rem 0.1rem 0.34rem;
  border-radius: var(--radius-full);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 0.7rem;
  line-height: 1.45;
}

.file-chip--media {
  padding-inline-start: 0.18rem;
}

/* Waiting for its turn: muted, so the file being uploaded stands out. */
.file-chip--queued {
  border-style: dashed;
  color: var(--text-3);
}

.file-chip--working {
  background: var(--info-soft);
  color: var(--info);
  border-color: color-mix(in srgb, var(--info) 25%, transparent);
}

.file-chip--done {
  background: var(--success-soft);
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 25%, transparent);
}

.file-chip--failed {
  background: var(--danger-soft);
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 25%, transparent);
}

.file-chip__main {
  display: inline-flex;
  align-items: center;
  gap: 0.24rem;
  min-width: 0;
  padding: 0;
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  text-align: start;
}

.file-chip__main[type='button'] {
  cursor: pointer;
}

.file-chip__main[type='button']:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius-full);
}

.file-chip__thumb {
  width: 1.3rem;
  height: 1.3rem;
  flex-shrink: 0;
  object-fit: cover;
  border-radius: var(--radius-xs);
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  background: var(--surface);
  transition: scale var(--motion-fast) var(--ease-out);
}

.file-chip--openable:hover .file-chip__thumb {
  scale: 1.08;
}

.file-chip__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
}

.file-chip__name {
  /* Keep short: four or five chips must share one row inside the composer. */
  max-width: 4.2rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  color: inherit;
}

.file-chip__state {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  opacity: 0.9;
}

.file-chip__spinner {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  animation: file-chip-spin 0.9s linear infinite;
}

@keyframes file-chip-spin {
  to {
    rotate: 360deg;
  }
}

.file-chip__retry {
  display: grid;
  place-items: center;
  width: 0.95rem;
  height: 0.95rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  opacity: 0.75;
  transition:
    opacity var(--motion-fast) var(--ease-out),
    background var(--motion-fast) var(--ease-out);
}

.file-chip__retry:hover {
  opacity: 1;
  background: color-mix(in srgb, currentColor 18%, transparent);
}

.file-chip__remove {
  display: grid;
  place-items: center;
  width: 0.88rem;
  height: 0.88rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  transition:
    opacity var(--motion-fast) var(--ease-out),
    background var(--motion-fast) var(--ease-out);
}

.file-chip__remove:hover {
  opacity: 1;
  background: color-mix(in srgb, currentColor 18%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .file-chip__spinner {
    animation: none;
  }

  .file-chip--openable:hover .file-chip__thumb {
    scale: 1;
  }
}
</style>
