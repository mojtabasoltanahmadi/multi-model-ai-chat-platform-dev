<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { formatBytes } from '../../utils/format';
import { fileKind } from '../../utils/fileKind';
import type { ChatFileStatus } from '../../api/types';

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
  previewUrl: null,
  requestPreview: undefined,
});

defineEmits<{ remove: []; open: [] }>();

const kind = computed(() => fileKind({ originalName: props.name, mimeType: props.mimeType }));

/** A thumbnail only makes sense for images we can actually decode in a tag. */
const showThumbnail = computed(() => kind.value === 'image' && Boolean(props.previewUrl));

/**
 * Status is carried by an icon alone — the chip stays narrow enough to fit
 * several files per row. The words live in the tooltip and the accessible name.
 */
const statusLabel = computed(() => {
  switch (props.status) {
    case 'UPLOADING':
      return 'در حال آپلود';
    case 'PROCESSING':
      return 'در حال پردازش';
    case 'READY':
      return 'آماده';
    case 'FAILED':
      return 'پردازش ناموفق';
    default:
      return '';
  }
});

const statusModifier = computed(() => `file-chip--${props.status.toLowerCase()}`);

/**
 * The words live in the tooltip and the accessible name only: the visible chip
 * is icon + truncated file name, so several files share one row.
 */
const title = computed(() => {
  const size = props.size > 0 ? formatBytes(props.size) : '';
  const parts = [props.name, size, statusLabel.value].filter(Boolean);
  if (props.status === 'FAILED' && props.errorMessage) parts.push(props.errorMessage);
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
    :class="[statusModifier, { 'file-chip--media': showThumbnail, 'file-chip--openable': clickable }]"
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

      <!-- status: spinner while working, check when ready, cross on failure -->
      <span class="file-chip__state" aria-hidden="true">
        <span
          v-if="status === 'UPLOADING' || status === 'PROCESSING'"
          class="file-chip__spinner"
        ></span>
        <svg
          v-else-if="status === 'READY'"
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

.file-chip--ready {
  background: var(--success-soft);
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 25%, transparent);
}

.file-chip--processing,
.file-chip--uploading {
  background: var(--info-soft);
  color: var(--info);
  border-color: color-mix(in srgb, var(--info) 25%, transparent);
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
