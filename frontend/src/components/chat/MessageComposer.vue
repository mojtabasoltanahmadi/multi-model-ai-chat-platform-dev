<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import ModelSelector from './ModelSelector.vue';
import FileChip from './FileChip.vue';
import { ACCEPTED_FILE_TYPES } from '../../api/client';
import type { AiModel, ChatFile } from '../../api/types';

const MAX_LENGTH = 4000;

interface Props {
  models: AiModel[];
  modelId: string;
  streaming: boolean;
  /** Files attached to the next message (any lifecycle status). */
  attachments?: ChatFile[];
  /** How many of the pending attachments are still uploading. */
  uploadingCount?: number;
  /** Object URLs for image thumbnails, keyed by file id. */
  previews?: Record<string, string>;
  /** Asks the view to fetch a thumbnail for a file restored from the server. */
  requestPreview?: (file: ChatFile) => void;
  disabled?: boolean;
  /** Shown when no conversation is active — sending will create one. */
  hint?: string;
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  hint: '',
  attachments: () => [],
  uploadingCount: 0,
  previews: () => ({}),
  requestPreview: undefined,
});
const emit = defineEmits<{
  send: [content: string];
  stop: [];
  'update:modelId': [id: string];
  attach: [files: File[]];
  'remove-attachment': [fileId: string];
  'clear-attachments': [];
  'open-file': [file: ChatFile];
}>();

const draft = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const uploading = computed(() => props.uploadingCount > 0);

/**
 * An upload in flight is the one thing that must block Send: the files are not
 * part of the conversation yet, so sending now would silently drop them. Files
 * that are only *processing* server-side do not block anything — chat stays
 * usable, and the message goes out with the files that are ready.
 */
const canSend = computed(
  () =>
    !props.disabled &&
    !props.streaming &&
    !uploading.value &&
    draft.value.trim().length > 0,
);

/** Attachments that are usable as context right now. */
const readyAttachments = computed(() =>
  props.attachments.filter((file) => file.status === 'READY'),
);

const pendingAttachmentCount = computed(
  () => props.attachments.length - readyAttachments.value.length,
);

function pickFiles() {
  fileInput.value?.click();
}

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
      Attachments live in their own tray ABOVE the input box, not inside it:
      the previews are files the user is about to send, not part of the text.
    -->
    <section
      v-if="attachments.length > 0"
      class="tray"
      aria-label="فایل‌های پیوست"
    >
      <header class="tray__head">
        <span class="tray__title">
          پیوست‌ها
          <span class="tray__count ltr">{{ attachments.length.toLocaleString('fa-IR') }}</span>
        </span>
        <button
          type="button"
          class="tray__clear"
          :disabled="disabled"
          @click="emit('clear-attachments')"
        >
          حذف همه
        </button>
      </header>

      <div class="tray__items">
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
          :clickable="file.status === 'READY'"
          removable
          @open="emit('open-file', file)"
          @remove="emit('remove-attachment', file.id)"
        />
      </div>

      <p class="tray__note">
        <template v-if="uploading">
          <span class="tray__dot" aria-hidden="true"></span>
          در حال آپلود
          {{ uploadingCount.toLocaleString('fa-IR') }}
          فایل — تا پایان آپلود امکان ارسال نیست.
        </template>
        <template v-else-if="pendingAttachmentCount > 0">
          فایل‌های در حال پردازش پس از آماده شدن به پیام پیوست می‌شوند.
        </template>
        <template v-else>
          روی فایل بزنید تا پیش‌نمایش را ببینید.
        </template>
      </p>
    </section>

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
      <!--
        Stays enabled during an upload: uploads are independent, so the user can
        keep queueing files (and keep typing) while earlier ones transfer.
      -->
      <button
        type="button"
        class="composer__attach"
        :disabled="disabled"
        aria-label="پیوست فایل (PDF، Excel یا تصویر)"
        title="پیوست فایل — می‌توانید چند فایل را همزمان انتخاب کنید"
        @click="pickFiles"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>

      <textarea
        ref="textarea"
        v-model="draft"
        class="composer__input"
        rows="1"
        :maxlength="MAX_LENGTH"
        :disabled="disabled"
        placeholder="پیام خود را بنویسید… (Shift + Enter برای خط جدید)"
        aria-label="متن پیام"
        @keydown="onKeydown"
      ></textarea>

      <div class="composer__side">
        <ModelSelector
          :models="models"
          :model-id="modelId"
          placement="up"
          compact
          @update:model-id="emit('update:modelId', $event)"
        />
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
          :aria-label="uploading ? 'تا پایان آپلود امکان ارسال نیست' : 'ارسال پیام'"
          :title="uploading ? 'تا پایان آپلود امکان ارسال نیست' : 'ارسال پیام'"
          @click="send"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 19V5m-7 7 7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>

    <div class="composer__under">
      <span v-if="counterVisible" class="composer__counter" :class="{ 'composer__counter--limit': draft.length >= MAX_LENGTH }">
        {{ draft.length.toLocaleString('fa-IR') }} / ۴٬۰۰۰
      </span>
      <span v-else-if="streaming" class="composer__status">
        <span class="composer__status-dot" aria-hidden="true"></span>
        در حال تولید پاسخ…
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

/* ---- attachment tray (outside the input box) ---- */
.tray {
  max-width: var(--chat-measure);
  margin: 0 auto 0.55rem;
  padding: 0.55rem 0.7rem 0.5rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-1);
}

.tray__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.45rem;
}

.tray__title {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-2);
}

.tray__count {
  padding: 0 0.38rem;
  border-radius: var(--radius-full);
  background: var(--surface-3);
  color: var(--text-2);
  font-size: 0.66rem;
}

.tray__clear {
  padding: 0.2rem 0.55rem;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  font-size: 0.7rem;
}

.tray__clear:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text-1);
}

.tray__items {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.tray__note {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0.45rem 0 0;
  font-size: 0.7rem;
  color: var(--text-3);
}

.tray__dot {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 50%;
  background: var(--info);
  animation: status-pulse 1.1s var(--ease-in-out) infinite;
}

.composer__box {
  display: flex;
  align-items: flex-end;
  gap: 0.45rem;
  max-width: var(--chat-measure);
  margin-inline: auto;
  padding: 0.5rem 0.55rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-2);
  transition:
    border-color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}

.composer__box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft), var(--shadow-2);
}

.composer--disabled .composer__box {
  opacity: 0.65;
}

.composer__file-input {
  display: none;
}

.composer__attach {
  display: grid;
  place-items: center;
  width: 2.3rem;
  height: 2.3rem;
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

.composer__input {
  flex: 1;
  /* A textarea's intrinsic width (default cols) otherwise forces the whole
     composer box past narrow viewports. */
  min-width: 0;
  min-height: 2.3rem;
  max-height: 11rem;
  padding: 0.4rem 0.2rem;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  font-size: 0.9rem;
  line-height: 1.7;
}

.composer__side {
  display: flex;
  align-items: flex-end;
  gap: 0.4rem;
  flex-shrink: 0;
}

.composer__send {
  display: grid;
  place-items: center;
  width: 2.3rem;
  height: 2.3rem;
  background: var(--accent);
  border: none;
  border-radius: var(--radius-full);
  color: var(--on-accent);
  transition:
    background var(--motion-fast) var(--ease-out),
    opacity var(--motion-fast) var(--ease-out),
    scale var(--motion-fast) var(--ease-out);
}

.composer__send:hover:not(:disabled) {
  background: var(--accent-hover);
}

.composer__send:active:not(:disabled) {
  scale: 0.94;
}

.composer__send:disabled {
  background: var(--surface-3);
  color: var(--text-disabled);
  cursor: not-allowed;
}

.composer__send--stop {
  background: var(--danger-soft);
  color: var(--danger);
}

.composer__send--stop:hover {
  background: var(--danger);
  color: #fff;
}

.composer__under {
  display: flex;
  justify-content: center;
  min-height: 1.2rem;
  padding-top: 0.3rem;
}

.composer__counter {
  font-size: 0.7rem;
  color: var(--text-3);
}

.composer__counter--limit {
  color: var(--danger);
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

  .tray {
    border-radius: var(--radius-md);
  }
}

@media (prefers-reduced-motion: reduce) {
  .tray__dot,
  .composer__status-dot {
    animation: none;
  }
}
</style>
