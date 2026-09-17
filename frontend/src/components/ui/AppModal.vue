<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

interface Props {
  title?: string;
  /** Small dialog (confirm) vs larger panel (form). */
  size?: 'sm' | 'md';
}

withDefaults(defineProps<Props>(), { title: '', size: 'sm' });

const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement | null>(null);
let previouslyFocused: HTMLElement | null = null;

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  previouslyFocused = document.activeElement as HTMLElement;
  panel.value?.focus();
  document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  previouslyFocused?.focus();
});
</script>

<template>
  <Teleport to="body">
    <Transition name="app-modal">
      <div class="app-modal__overlay" @mousedown.self="emit('close')">
        <div
          ref="panel"
          class="app-modal__panel"
          :class="`app-modal__panel--${size}`"
          role="dialog"
          aria-modal="true"
          :aria-label="title || undefined"
          tabindex="-1"
        >
          <header v-if="title" class="app-modal__header">
            <h2 class="app-modal__title">{{ title }}</h2>
            <button
              type="button"
              class="app-modal__close"
              aria-label="بستن"
              @click="emit('close')"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </header>
          <div class="app-modal__body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="app-modal__footer">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.app-modal__overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: grid;
  place-items: center;
  padding: 1.5rem;
  background: var(--overlay);
  backdrop-filter: blur(2px);
}

.app-modal__panel {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-overlay);
  outline: none;
  /* Tall dialogs (e.g. the model form) must stay reachable on small screens. */
  max-height: calc(100dvh - 3rem);
  overflow-y: auto;
}

.app-modal__panel--sm {
  max-width: 26rem;
}

.app-modal__panel--md {
  max-width: 34rem;
}

.app-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.4rem;
  border-bottom: 1px solid var(--border-subtle);
}

.app-modal__title {
  font-size: 1rem;
}

.app-modal__close {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  color: var(--text-3);
}

.app-modal__close:hover {
  background: var(--surface-2);
  color: var(--text-1);
}

.app-modal__body {
  padding: 1.2rem 1.4rem;
}

.app-modal__footer {
  display: flex;
  justify-content: flex-start;
  gap: 0.6rem;
  padding: 0.9rem 1.4rem 1.2rem;
}

/* transition */
.app-modal-enter-active,
.app-modal-leave-active {
  transition: opacity var(--motion-normal) var(--ease-out);
}

.app-modal-enter-active .app-modal__panel,
.app-modal-leave-active .app-modal__panel {
  transition: transform var(--motion-normal) var(--ease-out);
}

.app-modal-enter-from,
.app-modal-leave-to {
  opacity: 0;
}

.app-modal-enter-from .app-modal__panel,
.app-modal-leave-to .app-modal__panel {
  transform: translateY(10px) scale(0.98);
}
</style>
