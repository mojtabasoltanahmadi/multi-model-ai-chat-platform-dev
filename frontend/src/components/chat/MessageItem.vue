<script setup lang="ts">
import { computed, ref } from 'vue';
import AppAvatar from '../ui/AppAvatar.vue';
import { renderMarkdown } from '../../utils/markdown';
import { formatTime } from '../../utils/format';
import type { Message } from '../../api/types';

interface Props {
  message: Message;
  /** Model name for assistant attribution; fallback «دستیار هوشمند». */
  modelName?: string;
  /**
   * True while THIS component is the live-streaming row (its place is
   * filled by deltas). Distinct from a row whose persisted status is
   * 'streaming' — the latter means "an answer was being produced when we
   * last saw the row" and should render with a Retry affordance instead
   * of a caret.
   */
  streaming?: boolean;
  /** Disable the Retry button (e.g. while another send is in flight). */
  retryDisabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  streaming: false,
  modelName: '',
  retryDisabled: false,
});

const emit = defineEmits<{ retry: [message: Message] }>();

const copied = ref(false);
const isUser = computed(() => props.message.role === 'user');

/**
 * State-driven visuals:
 *   - 'failed'       → red error surface + Retry button + optional note
 *   - 'interrupted'  → muted surface + Retry button ("تولید متوقف شد")
 *   - 'pending'/'streaming' (without live deltas) → muted in-progress hint;
 *     we don't show the streaming caret because there are no live bytes
 *   - 'completed'    → full markdown rendering, copy button
 *   - null           → user row, plain text bubble
 */
const isFailed = computed(() => props.message.status === 'failed');
const isInterrupted = computed(() => props.message.status === 'interrupted');
const isInProgress = computed(
  () => props.message.status === 'pending' || props.message.status === 'streaming',
);
const statusLabel = computed(() => {
  if (isFailed.value) return 'خطا در تولید پاسخ';
  if (isInterrupted.value) return 'تولید پاسخ متوقف شد';
  if (isInProgress.value) return 'در حال تولید پاسخ';
  return '';
});

const canRetry = computed(
  () =>
    !props.streaming &&
    !props.retryDisabled &&
    (isFailed.value || isInterrupted.value),
);

const html = computed(() => {
  if (props.message.role !== 'assistant' || props.streaming) return '';
  return renderMarkdown(props.message.content);
});

/** During streaming, markdown is rendered progressively; plain text + caret reads calmer. */
const streamingHtml = computed(() => (props.streaming ? renderMarkdown(props.message.content) : ''));

async function copy() {
  try {
    await navigator.clipboard.writeText(props.message.content);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* clipboard unavailable (e.g. insecure context) — silently ignore */
  }
}

function retry() {
  if (!canRetry.value) return;
  emit('retry', props.message);
}
</script>

<template>
  <article class="message" :class="[isUser ? 'message--user' : 'message--assistant', message.status ? `message--${message.status}` : null]">
    <div v-if="!isUser" class="message__meta">
      <AppAvatar :name="modelName || 'دستیار'" :size="24" />
      <span class="message__author">{{ modelName || 'دستیار هوشمند' }}</span>
      <span class="message__time ltr">{{ formatTime(message.createdAt) }}</span>
    </div>

    <div
      class="message__body"
      :class="{
        'message__body--streaming': streaming,
        'message__body--failed': isFailed,
        'message__body--interrupted': isInterrupted,
      }"
      :dir="isUser ? 'auto' : undefined"
    >
      <!-- eslint-disable-next-line vue/no-v-html — sanitized: markdown-it runs with html:false -->
      <div
        v-if="isUser"
        class="message__content message__content--user"
      >{{ message.content }}</div>
      <div
        v-else-if="streaming"
        class="message__content message__content--streaming"
      >
        <!-- eslint-disable-next-line vue/no-v-html — sanitized: markdown-it runs with html:false -->
        <span v-html="streamingHtml"></span><span class="message__caret" aria-hidden="true"></span>
      </div>
      <div
        v-else-if="isInProgress"
        class="message__content message__content--in-progress"
        aria-live="polite"
      >
        {{ message.content }}
        <span class="message__dots" aria-hidden="true">…</span>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html — sanitized: markdown-it runs with html:false -->
      <div v-else class="message__content" v-html="html"></div>

      <!--
        Status notes are fixed, user-safe Persian strings. The persisted
        errorMessage is an internal ops detail (provider names, timeouts,
        transport events) and is deliberately never rendered.
      -->
      <p v-if="isFailed" class="message__error-note" role="status">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M12 8h.01M12 12v5" />
          <circle cx="12" cy="12" r="9" />
        </svg>
        سرویس هوش مصنوعی موقتاً در دسترس نیست. لطفاً دوباره تلاش کنید.
      </p>
      <p v-else-if="isInterrupted" class="message__error-note" role="status">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M12 8h.01M12 12v5" />
          <circle cx="12" cy="12" r="9" />
        </svg>
        تولید این پاسخ ناتمام ماند — می‌توانید دوباره تلاش کنید.
      </p>
    </div>

    <div v-if="!isUser && !streaming" class="message__actions">
      <button
        v-if="canRetry"
        type="button"
        class="message__action message__action--retry"
        :aria-label="`تلاش مجدد ${statusLabel}`"
        :title="`تلاش مجدد ${statusLabel}`"
        @click="retry"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
        <span class="message__action-label">تلاش مجدد</span>
      </button>
      <button
        type="button"
        class="message__action"
        :aria-label="copied ? 'کپی شد' : 'کپی پاسخ'"
        :title="copied ? 'کپی شد' : 'کپی پاسخ'"
        @click="copy"
      >
        <svg v-if="!copied" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </button>
    </div>
  </article>
</template>

<style scoped>
.message {
  display: grid;
  gap: 0.45rem;
  animation: message-in var(--motion-normal) var(--ease-out);
}

@keyframes message-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* --- user message: subtle distinct surface, aligned to the inline start --- */
.message--user {
  justify-items: start;
}

.message__body--streaming {
  min-height: 1.6rem;
}

.message--user .message__body {
  max-width: min(46rem, 100%);
}

.message__content--user {
  padding: 0.65rem 1rem;
  background: var(--accent-soft);
  border: 1px solid var(--accent-soft-border);
  border-radius: var(--radius-lg);
  border-start-end-radius: var(--radius-xs);
  font-size: 0.9rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* --- assistant message: workspace content, no heavy bubble --- */
.message--assistant {
  gap: 0.35rem;
}

.message__meta {
  display: flex;
  align-items: center;
  gap: 0.45rem;
}

.message__author {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-1);
}

.message__time {
  font-size: 0.7rem;
  color: var(--text-3);
}

.message__body {
  min-width: 0;
}

.message__content {
  font-size: 0.9rem;
  overflow-wrap: anywhere;
}

.message--assistant .message__body {
  padding-inline-start: 2.1rem; /* aligns with the avatar column */
}

/* markdown typography */
.message__content :deep(p) {
  margin: 0 0 0.7rem;
}

.message__content :deep(p:last-child) {
  margin-bottom: 0;
}

.message__content :deep(ul),
.message__content :deep(ol) {
  margin: 0.4rem 0 0.8rem;
  padding-inline-start: 1.4rem;
}

.message__content :deep(li) {
  margin-bottom: 0.25rem;
}

.message__content :deep(h1),
.message__content :deep(h2),
.message__content :deep(h3),
.message__content :deep(h4) {
  font-size: 1em;
  margin: 1rem 0 0.4rem;
}

.message__content :deep(a) {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.message__content :deep(blockquote) {
  margin: 0.6rem 0;
  padding: 0.35rem 0.9rem;
  border-inline-start: 3px solid var(--accent-soft-border);
  background: var(--surface-inset);
  border-radius: var(--radius-xs);
  color: var(--text-2);
}

.message__content :deep(pre) {
  margin: 0.6rem 0 0.9rem;
  padding: 0.85rem 1rem;
  background: var(--surface-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow-x: auto;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 0.8rem;
  line-height: 1.7;
  text-align: left;
  direction: ltr;
}

.message__content :deep(code) {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 0.82em;
  background: var(--surface-2);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xs);
  padding: 0.05em 0.35em;
}

.message__content :deep(pre code) {
  background: none;
  border: none;
  padding: 0;
}

.message__content :deep(table) {
  border-collapse: collapse;
  font-size: 0.82rem;
  margin: 0.6rem 0;
  /* Wide markdown tables scroll inside the message column instead of
     stretching the page horizontally. */
  display: block;
  overflow-x: auto;
}

.message__content :deep(th),
.message__content :deep(td) {
  border: 1px solid var(--border);
  padding: 0.3rem 0.65rem;
}

/* streaming */
.message__content--streaming {
  display: inline;
}

.message__caret {
  display: inline-block;
  width: 0.5rem;
  height: 1.05rem;
  margin-inline-start: 0.15rem;
  vertical-align: text-bottom;
  border-radius: var(--radius-xs);
  background: var(--accent);
  animation: caret-pulse 1s var(--ease-in-out) infinite;
}

@keyframes caret-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

/* error */
.message__body--failed,
.message__body--interrupted {
  opacity: 0.92;
}

.message__body--failed .message__content {
  color: var(--danger);
}

.message__body--interrupted .message__content {
  color: var(--text-2);
  font-style: italic;
}

.message__content--in-progress {
  color: var(--text-2);
  font-style: italic;
}

.message__dots {
  display: inline-block;
  margin-inline-start: 0.15rem;
  letter-spacing: 0.15em;
  animation: dots-pulse 1.4s ease-in-out infinite;
}

@keyframes dots-pulse {
  0%,
  100% {
    opacity: 0.3;
  }
  50% {
    opacity: 1;
  }
}

.message__error-note {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.4rem;
  font-size: 0.75rem;
  color: var(--danger);
}

/* actions */
.message__actions {
  display: flex;
  gap: 0.25rem;
  padding-inline-start: 2.1rem;
}

.message__action {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  height: 1.8rem;
  padding-inline: 0.55rem;
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  color: var(--text-3);
  font-size: 0.74rem;
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.message__action:hover {
  background: var(--surface-2);
  color: var(--text-1);
}

.message__action--retry {
  color: var(--accent);
}

.message__action--retry:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
}

.message__action-label {
  font-weight: 500;
}
</style>
