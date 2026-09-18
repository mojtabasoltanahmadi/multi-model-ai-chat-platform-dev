<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import ModelSelector from './ModelSelector.vue';
import FileChip from './FileChip.vue';
import { ACCEPTED_FILE_TYPES } from '../../api/client';
import type { AiModel, ChatFile, ComposerFile } from '../../api/types';

const MAX_LENGTH = 4000;

/** Live web-search progress of the in-flight turn (null when idle). */
export interface SearchStatus {
  phase: 'searching' | 'succeeded';
  resultCount: number;
}

interface Props {
  models: AiModel[];
  modelId: string;
  streaming: boolean;
  /** Opt-in web search for the next turn (persisted by the view). */
  webSearchEnabled?: boolean;
  searchStatus?: SearchStatus | null;
  /** Files added to the next message, each with its own upload state. */
  attachments?: ComposerFile[];
  /** Object URLs for image thumbnails, keyed by file id. */
  previews?: Record<string, string>;
  /** Asks the view to fetch a thumbnail for a file restored from the server. */
  requestPreview?: (file: ComposerFile) => void;
  disabled?: boolean;
  /** Shown when no conversation is active — sending will create one. */
  hint?: string;
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  hint: '',
  attachments: () => [],
  previews: () => ({}),
  requestPreview: undefined,
  webSearchEnabled: false,
  searchStatus: null,
});
const emit = defineEmits<{
  send: [content: string];
  stop: [];
  'update:modelId': [id: string];
  'update:webSearchEnabled': [enabled: boolean];
  attach: [files: File[]];
  'remove-attachment': [fileId: string];
  'retry-upload': [fileId: string];
  'open-file': [file: ChatFile];
}>();

const draft = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

/** Files with an upload still outstanding: queued, in flight, or failed. */
const uploadsPending = computed(() =>
  props.attachments.filter((file) => file.upload !== 'completed'),
);

const failedUpload = computed(
  () => uploadsPending.value.find((file) => file.upload === 'error') ?? null,
);

/** Uploaded files whose content is ready, so they can carry a message alone. */
const readyAttachments = computed(() =>
  props.attachments.filter((file) => file.upload === 'completed' && file.status === 'READY'),
);

/**
 * Send is locked until every picked file has been uploaded — typing a message
 * does not unlock it. A failed upload also keeps it locked until the user
 * retries or removes that file. Server-side processing never blocks the chat,
 * and a message without files behaves exactly as before.
 */
const canSend = computed(
  () =>
    !props.disabled &&
    !props.streaming &&
    uploadsPending.value.length === 0 &&
    (draft.value.trim().length > 0 || readyAttachments.value.length > 0),
);

/** Why Send is locked; the button's tooltip and accessible name say it. */
const sendLockReason = computed(() => {
  if (failedUpload.value) return 'آپلود یک فایل ناموفق بود؛ دوباره تلاش کنید یا فایل را حذف کنید.';
  if (uploadsPending.value.length > 0) return 'تا پایان آپلود همهٔ فایل‌ها امکان ارسال نیست.';
  return '';
});

function pickFiles() {
  fileInput.value?.click();
}

function toggleWebSearch() {
  if (props.disabled || props.streaming) return;
  emit('update:webSearchEnabled', !props.webSearchEnabled);
}

/** Single status line under the box: searching outranks generating. */
const statusText = computed(() => {
  if (props.searchStatus?.phase === 'searching') return 'در حال جستجو در وب…';
  if (!props.streaming) return '';
  if (props.searchStatus?.phase === 'succeeded') {
    const count = props.searchStatus.resultCount.toLocaleString('fa-IR');
    return `${count} منبع پیدا شد • در حال تولید پاسخ…`;
  }
  return 'در حال تولید پاسخ…';
});

function onFilesChosen(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (files.length > 0) emit('attach', files);
  // Reset so choosing the same files again still fires a change event.
  input.value = '';
}

const counterVisible = computed(() => draft.value.length > MAX_LENGTH * 0.9);

function autoResize() {
  const element = textarea.value;
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${Math.min(element.scrollHeight, 176)}px`;
}

watch(draft, () => void nextTick(autoResize));

function send() {
  if (!canSend.value) return;
  emit('send', draft.value.trim());
  draft.value = '';
  void nextTick(autoResize);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
}

defineExpose({ focus: () => textarea.value?.focus() });
</script>

<template>
  <div class="composer" :class="{ 'composer--disabled': disabled }">
    <div v-if="hint" class="composer__hint">{{ hint }}</div>

    <!--
      Files live INSIDE the input box, right where the user types: they are part
      of the message being written, so the box grows to hold them.
    -->
    <div class="composer__box" :class="{ 'composer__box--streaming': streaming }">
      <input
        ref="fileInput"
        type="file"
        class="composer__file-input"
        :accept="ACCEPTED_FILE_TYPES"
        :disabled="disabled"
        multiple
        aria-hidden="true"
        tabindex="-1"
        @change="onFilesChosen"
      />

      <div v-if="attachments.length > 0" class="composer__files" aria-label="فایل‌های افزوده‌شده">
        <FileChip
          v-for="file in attachments"
          :key="file.id"
          :name="file.originalName"
          :status="file.status"
          :mime-type="file.mimeType"
          :size="file.size"
          :error-message="file.errorMessage"
          :preview-url="previews[file.id] ?? null"
          :request-preview="requestPreview ? () => requestPreview?.(file) : undefined"
          :upload="file.upload"
          :upload-error="file.uploadError"
          :clickable="file.upload === 'completed' && file.status === 'READY'"
          removable
          @open="emit('open-file', file)"
          @remove="emit('remove-attachment', file.id)"
          @retry="emit('retry-upload', file.id)"
        />
      </div>

      <textarea
        ref="textarea"
        v-model="draft"
        class="composer__input"
        rows="1"
        :maxlength="MAX_LENGTH"
        :disabled="disabled"
        placeholder="هر سوالی داری بپرس… (Shift + Enter برای خط جدید)"
        aria-label="متن پیام"
        @keydown="onKeydown"
      ></textarea>

      <!-- Toolbar under the text, like the reference composer. -->
      <div class="composer__toolbar">
        <!--
          The attach button stays enabled while files upload: only Send locks,
          so the user can keep adding files (and writing) the whole time.
        -->
        <button
          type="button"
          class="composer__attach"
          :disabled="disabled"
          aria-label="افزودن فایل (PDF، Excel یا تصویر)"
          title="افزودن فایل (PDF، Excel یا تصویر)"
          @click="pickFiles"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>

        <ModelSelector
          :models="models"
          :model-id="modelId"
          placement="up"
          compact
          @select="emit('update:modelId', $event)"
        />

        <button
          type="button"
          class="composer__search-toggle"
          :class="{ 'composer__search-toggle--active': webSearchEnabled }"
          :disabled="disabled || streaming"
          :aria-pressed="webSearchEnabled"
          :aria-label="webSearchEnabled ? 'جستجوی وب فعال است؛ برای خاموش کردن بزنید' : 'جستجوی وب خاموش است؛ برای فعال کردن بزنید'"
          :title="webSearchEnabled ? 'جستجوی وب فعال' : 'جستجوی وب'"
          @click="toggleWebSearch"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18" />
            <path d="M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z" />
          </svg>
          <span class="composer__search-label">جستجوی وب</span>
        </button>

        <span class="composer__toolbar-spacer"></span>

        <span
          v-if="counterVisible"
          class="composer__counter"
          :class="{ 'composer__counter--limit': draft.length >= MAX_LENGTH }"
        >
          {{ draft.length.toLocaleString('fa-IR') }} / ۴٬۰۰۰
        </span>

        <button
          v-if="streaming"
          type="button"
          class="composer__send composer__send--stop"
          aria-label="توقف تولید پاسخ"
          title="توقف تولید پاسخ"
          @click="emit('stop')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        </button>
        <button
          v-else
          type="button"
          class="composer__send"
          :disabled="!canSend"
          :aria-label="sendLockReason || 'ارسال پیام'"
          :title="sendLockReason || 'ارسال پیام'"
          @click="send"
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 19V5m-7 7 7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>

    <div class="composer__under">
      <span v-if="statusText" class="composer__status" role="status" aria-live="polite">
        <span class="composer__status-dot" aria-hidden="true"></span>
        {{ statusText }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.composer {
  padding: 0.6rem 1.5rem 1rem;
}

.composer__hint {
  max-width: var(--chat-measure);
  margin: 0 auto 0.4rem;
  font-size: 0.72rem;
  color: var(--text-3);
  text-align: center;
}

.composer__box {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-width: var(--chat-measure);
  margin-inline: auto;
  padding: 0.6rem 0.65rem 0.55rem;
  background: var(--composer-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-2);
  transition:
    border-color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}

.composer__box:focus-within {
  border-color: var(--focus-border);
  box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-glow);
}

.composer--disabled .composer__box {
  opacity: 0.65;
}

/* The file row sits above the text row, inside the box. */
.composer__files {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
  padding: 0.05rem 0.1rem 0.4rem;
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 0.3rem;
}

.composer__file-input {
  display: none;
}

.composer__input {
  width: 100%;
  /* A textarea's intrinsic width (default cols) otherwise forces the whole
     composer box past narrow viewports. */
  min-width: 0;
  min-height: 2.2rem;
  max-height: 11rem;
  padding: 0.35rem 0.55rem;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  font-size: 0.92rem;
  line-height: 1.7;
}

.composer__toolbar {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.composer__toolbar-spacer {
  flex: 1;
}

.composer__attach {
  display: grid;
  place-items: center;
  width: 2.2rem;
  height: 2.2rem;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.composer__attach:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text-1);
}

.composer__attach:disabled {
  color: var(--text-disabled);
  cursor: not-allowed;
}

.composer__search-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  height: 2.2rem;
  padding-inline: 0.6rem;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  font-size: 0.75rem;
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out);
}

.composer__search-toggle:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text-1);
}

.composer__search-toggle:disabled {
  color: var(--text-disabled);
  cursor: not-allowed;
}

.composer__search-toggle--active {
  background: var(--accent-soft);
  border-color: var(--accent-soft-border);
  color: var(--text-on-accent-soft);
}

.composer__search-toggle--active:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--text-on-accent-soft);
  filter: brightness(1.05);
}

.composer__search-label {
  white-space: nowrap;
}

.composer__counter {
  font-size: 0.7rem;
  color: var(--text-3);
}

.composer__counter--limit {
  color: var(--danger);
}

.composer__send {
  display: grid;
  place-items: center;
  width: 2.4rem;
  height: 2.4rem;
  flex-shrink: 0;
  background: var(--gradient-primary);
  border: none;
  border-radius: var(--radius-full);
  color: var(--on-accent);
  box-shadow: var(--shadow-glow);
  transition:
    filter var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out),
    opacity var(--motion-fast) var(--ease-out),
    scale var(--motion-fast) var(--ease-out);
}

.composer__send:hover:not(:disabled) {
  filter: brightness(1.1);
  box-shadow: var(--shadow-glow-strong);
}

.composer__send:active:not(:disabled) {
  scale: 0.94;
  filter: brightness(0.97);
}

.composer__send:disabled {
  background: var(--surface-3);
  color: var(--text-disabled);
  box-shadow: none;
}

.composer__send--stop {
  background: var(--danger-soft);
  color: var(--danger);
  box-shadow: none;
}

.composer__send--stop:hover {
  background: var(--danger);
  color: #fff;
  filter: none;
}

.composer__under {
  display: flex;
  justify-content: center;
  min-height: 1.2rem;
  padding-top: 0.3rem;
}

.composer__status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.72rem;
  color: var(--text-3);
}

.composer__status-dot {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 50%;
  background: var(--accent);
  animation: status-pulse 1.1s var(--ease-in-out) infinite;
}

@keyframes status-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

@media (max-width: 640px) {
  .composer {
    padding: 0.5rem 0.9rem 0.8rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .composer__status-dot {
    animation: none;
  }
}
</style>
