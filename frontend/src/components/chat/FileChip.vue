<script setup lang="ts">
import { computed } from 'vue';
import { formatBytes } from '../../utils/format';
import type { ChatFileStatus } from '../../api/types';

interface Props {
  name: string;
  status: ChatFileStatus;
  size?: number;
  /** Safe backend reason, shown for FAILED files. */
  errorMessage?: string | null;
  /** Shows the remove button (composer chips only). */
  removable?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  size: 0,
  errorMessage: null,
  removable: false,
});

defineEmits<{ remove: [] }>();

/** Emoji-free icon per pipeline: document, sheet, image. */
const kind = computed<'pdf' | 'sheet' | 'image' | 'file'>(() => {
  const name = props.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.xls') || name.endsWith('.xlsx')) return 'sheet';
  if (/\.(png|jpe?g)$/.test(name)) return 'image';
  return 'file';
});

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
</script>

<template>
  <span
    class="file-chip"
    :class="statusModifier"
    :title="title"
    role="status"
    :aria-label="`${name} — ${title}`"
  >
    <!-- kind icon -->
    <svg
      v-if="kind === 'image'"
      width="13"
      height="13"
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
      width="13"
      height="13"
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
      width="13"
      height="13"
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

    <span class="file-chip__name">{{ name }}</span>

    <span v-if="size" class="file-chip__size ltr">{{ formatBytes(size) }}</span>

    <!-- status affordance: spinner while working, check when ready, cross on failure -->
    <span class="file-chip__status">
      <span v-if="status === 'UPLOADING' || status === 'PROCESSING'" class="file-chip__spinner" aria-hidden="true"></span>
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
      <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
      <span class="file-chip__label">{{ statusLabel }}</span>
    </span>

    <button
      v-if="removable"
      type="button"
      class="file-chip__remove"
      :aria-label="`حذف پیوست ${name}`"
      :title="`حذف پیوست ${name}`"
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
  gap: 0.4rem;
  max-width: 100%;
  padding: 0.24rem 0.6rem;
  border-radius: var(--radius-full);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 0.74rem;
  line-height: 1.5;
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

.file-chip__name {
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  color: inherit;
}

.file-chip__size {
  font-size: 0.68rem;
  opacity: 0.8;
}

.file-chip__status {
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
}

.file-chip__label {
  font-size: 0.7rem;
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
}
</style>
