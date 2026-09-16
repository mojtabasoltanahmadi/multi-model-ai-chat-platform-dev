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
  /** True while an upload is in flight. */
  uploading?: boolean;
  disabled?: boolean;
  /** Shown when no conversation is active — sending will create one. */
  hint?: string;
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
  hint: '',
  attachments: () => [],
  uploading: false,
});
const emit = defineEmits<{
  send: [content: string];
  stop: [];
  'update:modelId': [id: string];
  attach: [file: File];
  'remove-attachment': [fileId: string];
}>();

const draft = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const canSend = computed(
  () => !props.disabled && !props.streaming && draft.value.trim().length > 0,
);

/** Attachments that are usable as context right now. */
const readyAttachments = computed(() =>
  props.attachments.filter((file) => file.status === 'READY'),
);

/**
 * A file that is still processing is not silently dropped from the user's
 * view, but it also cannot be sent as context: the hint explains why the
 * message will go out without it.
 */
const pendingAttachmentCount = computed(
  () => props.attachments.length - readyAttachments.value.length,
);

function pickFile() {
  fileInput.value?.click();
}

function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) emit('attach', file);
  // Reset so choosing the same file again still fires a change event.
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

    <!-- Attached files: visible from upload through processing to ready/failed. -->
    <div v-if="attachments.length > 0" class="composer__attachments" aria-label="فایل‌های پیوست">
      <FileChip
        v-for="file in attachments"
        :key="file.id"
        :name="file.originalName"
        :status="file.status"
        :size="file.size"
        :error-message="file.errorMessage"
        removable
        @remove="emit('remove-attachment', file.id)"
      />
      <span v-if="uploading" class="composer__attachment-note">در حال آپلود فایل…</span>
      <span v-else-if="pendingAttachmentCount > 0" class="composer__attachment-note">
        فایل‌های در حال پردازش پس از آماده شدن به پیام پیوست می‌شوند.
      </span>
    </div>

    <div
      class="composer__box"
      :class="{ 'composer__box--streaming': streaming }"
    >
      <input
        ref="fileInput"
        type="file"
        class="composer__file-input"
        :accept="ACCEPTED_FILE_TYPES"
        :disabled="disabled"
        aria-hidden="true"
        tabindex="-1"
        @change="onFileChosen"
      />
      <button
        type="button"
        class="composer__attach"
        :disabled="disabled || uploading"
        aria-label="پیوست فایل (PDF، Excel یا تصویر)"
        title="پیوست فایل (PDF، Excel یا تصویر)"
        @click="pickFile"
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
          aria-label="ارسال پیام"
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

.composer__attachments {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  max-width: var(--chat-measure);
  margin: 0 auto 0.45rem;
}

.composer__attachment-note {
  font-size: 0.7rem;
  color: var(--text-3);
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
}
</style>
