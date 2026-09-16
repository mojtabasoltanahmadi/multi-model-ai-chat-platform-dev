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

const statusLabel = computed(() => {
  switch (props.status) {
    case 'UPLOADING':
      return 'در حال آپلود…';
    case 'PROCESSING':
      return 'در حال پردازش…';
    case 'READY':
      return 'آماده';
    case 'FAILED':
      return 'پردازش ناموفق';
    default:
      return '';
  }
});

const statusModifier = computed(() => `file-chip--${props.status.toLowerCase()}`);

/** Failures explain themselves; the raw backend reason is already user-safe. */
const title = computed(() =>
  props.status === 'FAILED' && props.errorMessage ? props.errorMessage : statusLabel.value,
);

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
    :aria-label="`${name} — ${title}`"
  >
    <component
      :is="clickable ? 'button' : 'span'"
      class="file-chip__main"
      :type="clickable ? 'button' : undefined"
      :title="clickable ? `${name} — مشاهده` : title"
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
          width="14"
          height="14"
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
          width="14"
          height="14"
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
          width="14"
          height="14"
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

      <span class="file-chip__text">
        <span class="file-chip__name">{{ name }}</span>
        <span class="file-chip__meta">
          <span v-if="size" class="file-chip__size ltr">{{ formatBytes(size) }}</span>
          <span class="file-chip__state">
            <span
              v-if="status === 'UPLOADING' || status === 'PROCESSING'"
              class="file-chip__spinner"
              aria-hidden="true"
            ></span>
            <svg
              v-else-if="status === 'READY'"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
            <svg
              v-else
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
            <span class="file-chip__label">{{ statusLabel }}</span>
          </span>
        </span>
      </span>

      <!-- hover affordance: this chip opens a preview -->
      <span v-if="clickable" class="file-chip__peek" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
          <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
          <circle cx="12" cy="12" r="2.6" />
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
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  </span>
</template>

<style scoped>
/* Same pill language as the admin status badges. */
.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  max-width: 100%;
  padding: 0.22rem 0.5rem 0.22rem 0.6rem;
  border-radius: var(--radius-full);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 0.74rem;
  line-height: 1.5;
}

.file-chip--media {
  padding: 0.28rem 0.55rem;
  border-radius: var(--radius-md);
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
  gap: 0.45rem;
  max-width: 100%;
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
  border-radius: var(--radius-sm);
}

.file-chip__thumb {
  width: 2.5rem;
  height: 2.5rem;
  flex-shrink: 0;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  background: var(--surface);
  transition: scale var(--motion-fast) var(--ease-out);
}

.file-chip--openable:hover .file-chip__thumb {
  scale: 1.06;
}

.file-chip__icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
}

.file-chip__text {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  min-width: 0;
}

.file-chip__name {
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  color: inherit;
}

.file-chip__meta {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.68rem;
  opacity: 0.9;
}

.file-chip__state {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.file-chip__label {
  white-space: nowrap;
}

.file-chip__spinner {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  animation: file-chip-spin 0.9s linear infinite;
}

.file-chip__peek {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-out);
}

.file-chip--openable:hover .file-chip__peek,
.file-chip--openable:focus-within .file-chip__peek {
  opacity: 0.85;
}

@keyframes file-chip-spin {
  to {
    rotate: 360deg;
  }
}

.file-chip__remove {
  display: grid;
  place-items: center;
  width: 1.05rem;
  height: 1.05rem;
  margin-inline-start: 0.1rem;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  opacity: 0.7;
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
