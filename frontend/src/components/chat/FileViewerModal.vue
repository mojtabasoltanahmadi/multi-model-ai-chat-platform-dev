<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { fetchFileContent } from '../../api/client';
import { canPreviewInline, fileKind, fileKindLabel } from '../../utils/fileKind';
import { formatBytes } from '../../utils/format';
import { downloadUrl } from '../../utils/download';
import type { ChatFile } from '../../api/types';

interface Props {
  file: ChatFile;
  /** Object URL the parent already has (image thumbnails); avoids a refetch. */
  previewUrl?: string | null;
}

const props = withDefaults(defineProps<Props>(), { previewUrl: null });
const emit = defineEmits<{ close: [] }>();

const kind = computed(() => fileKind(props.file));
const kindLabel = computed(() => fileKindLabel(kind.value));
const previewable = computed(() => canPreviewInline(kind.value));

/** Object URL this component owns — revoked on close (the parent owns its own). */
const ownedUrl = ref<string | null>(null);
const loading = ref(false);
const error = ref('');
const downloading = ref(false);
let previouslyFocused: HTMLElement | null = null;

const source = computed(() => props.previewUrl ?? ownedUrl.value ?? '');

function revokeOwned() {
  if (ownedUrl.value) URL.revokeObjectURL(ownedUrl.value);
  ownedUrl.value = null;
}

/** Images normally arrive with a cached preview; PDFs (and restored images) need bytes. */
async function ensureSource() {
  if (source.value) return;
  loading.value = true;
  error.value = '';
  try {
    const blob = await fetchFileContent(props.file.id);
    revokeOwned();
    ownedUrl.value = URL.createObjectURL(blob);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'دریافت فایل ممکن نشد.';
  } finally {
    loading.value = false;
  }
}

async function download() {
  if (downloading.value) return;
  if (source.value) {
    downloadUrl(source.value, props.file.originalName);
    return;
  }
  downloading.value = true;
  error.value = '';
  try {
    const blob = await fetchFileContent(props.file.id);
    const url = URL.createObjectURL(blob);
    downloadUrl(url, props.file.originalName);
    // Give the browser a moment to start the download before releasing the URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 15000);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'دانلود فایل ممکن نشد.';
  } finally {
    downloading.value = false;
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  previouslyFocused = document.activeElement as HTMLElement;
  document.addEventListener('keydown', onKeydown);
  // The viewer is a modal surface: the page behind it must not scroll.
  document.body.style.overflow = 'hidden';
  void ensureSource();
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  document.body.style.overflow = '';
  revokeOwned();
  previouslyFocused?.focus();
});
</script>

<template>
  <Teleport to="body">
    <Transition name="file-viewer">
      <div
        class="viewer"
        role="dialog"
        aria-modal="true"
        :aria-label="file.originalName"
        @mousedown.self="emit('close')"
      >
        <div class="viewer__panel">
          <header class="viewer__header">
            <span class="viewer__kind">{{ kindLabel }}</span>
            <span class="viewer__name" :title="file.originalName">{{ file.originalName }}</span>
            <span v-if="file.size" class="viewer__size ltr">{{ formatBytes(file.size) }}</span>
            <button
              type="button"
              class="viewer__close"
              aria-label="بستن پیش‌نمایش"
              title="بستن (Esc)"
              @click="emit('close')"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </header>

          <div class="viewer__body">
            <div v-if="loading" class="viewer__state">
              <span class="viewer__spinner" aria-hidden="true"></span>
              در حال آماده‌سازی پیش‌نمایش…
            </div>

            <template v-else-if="source">
              <img
                v-if="kind === 'image'"
                class="viewer__image"
                :src="source"
                :alt="file.originalName"
              />
              <iframe
                v-else-if="kind === 'pdf'"
                class="viewer__frame"
                :src="source"
                :title="file.originalName"
              ></iframe>
              <div v-else class="viewer__state">
                پیش‌نمایش این نوع فایل در مرورگر ممکن نیست. برای مشاهده، آن را دانلود کنید.
              </div>
            </template>

            <div v-else class="viewer__state viewer__state--bad">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v4m0 4h.01" />
              </svg>
              <p>{{ error || 'پیش‌نمایش قابل نمایش نیست.' }}</p>
              <button type="button" class="viewer__retry" @click="ensureSource">تلاش مجدد</button>
            </div>
          </div>

          <footer class="viewer__footer">
            <p v-if="error && source" class="viewer__error">{{ error }}</p>
            <div class="viewer__actions">
              <button
                v-if="previewable || !loading"
                type="button"
                class="viewer__download"
                :disabled="downloading"
                @click="download"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" />
                </svg>
                {{ downloading ? 'در حال آماده‌سازی…' : 'دانلود فایل' }}
              </button>
              <button type="button" class="viewer__dismiss" @click="emit('close')">بستن</button>
            </div>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: 1.25rem;
  /* Blurred backdrop: the conversation stays visible but out of focus. */
  background: color-mix(in srgb, var(--text-1) 45%, transparent);
  backdrop-filter: blur(10px);
}

.viewer__panel {
  display: flex;
  flex-direction: column;
  width: min(62rem, 100%);
  max-height: calc(100dvh - 2.5rem);
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-overlay);
}

.viewer__header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.75rem 0.9rem 0.75rem 1.1rem;
  border-bottom: 1px solid var(--border-subtle);
}

.viewer__kind {
  flex-shrink: 0;
  padding: 0.14rem 0.5rem;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--text-on-accent-soft);
  font-size: 0.68rem;
  font-weight: 600;
}

.viewer__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  font-size: 0.9rem;
}

.viewer__size {
  flex-shrink: 0;
  margin-inline-start: auto;
  font-size: 0.72rem;
  color: var(--text-3);
}

.viewer__close {
  display: grid;
  place-items: center;
  width: 2.2rem;
  height: 2.2rem;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.viewer__close:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

.viewer__body {
  flex: 1;
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 1rem;
  overflow: auto;
  background: var(--surface-inset);
}

.viewer__image {
  max-width: 100%;
  max-height: min(72dvh, 40rem);
  object-fit: contain;
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-2);
}

.viewer__frame {
  width: 100%;
  height: min(72dvh, 42rem);
  border: none;
  border-radius: var(--radius-md);
  /* PDF viewers assume a white page regardless of the app theme. */
  background: #fff;
}

.viewer__state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.7rem;
  padding: 2rem 1rem;
  max-width: 26rem;
  text-align: center;
  font-size: 0.84rem;
  color: var(--text-2);
}

.viewer__state--bad {
  color: var(--danger);
}

.viewer__state--bad p {
  color: var(--text-2);
}

.viewer__spinner {
  width: 1.3rem;
  height: 1.3rem;
  border-radius: 50%;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  animation: viewer-spin 0.9s linear infinite;
}

@keyframes viewer-spin {
  to {
    rotate: 360deg;
  }
}

.viewer__retry {
  padding: 0.35rem 0.9rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--surface);
  color: var(--text-1);
  font-size: 0.78rem;
}

.viewer__footer {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.7rem 1.1rem;
  border-top: 1px solid var(--border-subtle);
}

.viewer__error {
  margin: 0;
  font-size: 0.74rem;
  color: var(--danger);
}

.viewer__actions {
  display: flex;
  gap: 0.5rem;
  margin-inline-start: auto;
}

.viewer__download {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 1.05rem;
  background: var(--accent);
  border: none;
  border-radius: var(--radius-full);
  color: var(--on-accent);
  font-size: 0.82rem;
  font-weight: 500;
  transition: background var(--motion-fast) var(--ease-out);
}

.viewer__download:hover:not(:disabled) {
  background: var(--accent-hover);
}

.viewer__download:disabled {
  background: var(--surface-3);
  color: var(--text-disabled);
}

.viewer__dismiss {
  padding: 0.5rem 1.05rem;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  color: var(--text-2);
  font-size: 0.82rem;
}

.viewer__dismiss:hover {
  background: var(--surface-2);
  color: var(--text-1);
}

/* transition */
.file-viewer-enter-active,
.file-viewer-leave-active {
  transition: opacity var(--motion-normal) var(--ease-out);
}

.file-viewer-enter-active .viewer__panel,
.file-viewer-leave-active .viewer__panel {
  transition: transform var(--motion-normal) var(--ease-out);
}

.file-viewer-enter-from,
.file-viewer-leave-to {
  opacity: 0;
}

.file-viewer-enter-from .viewer__panel,
.file-viewer-leave-to .viewer__panel {
  transform: translateY(8px) scale(0.985);
}

@media (max-width: 640px) {
  .viewer {
    padding: 0.6rem;
  }

  .viewer__panel {
    max-height: calc(100dvh - 1.2rem);
  }

  .viewer__size {
    display: none;
  }

  .viewer__actions {
    width: 100%;
  }

  .viewer__download,
  .viewer__dismiss {
    flex: 1;
    justify-content: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .viewer__spinner {
    animation: none;
  }
}
</style>
