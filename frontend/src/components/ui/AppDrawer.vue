<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * Side drawer panel (teleported) — hosts the admin configuration panel and
 * similar contextual surfaces. `side='end'` docks to the inline-end edge
 * (left in RTL, like the reference detail panel); 'start' docks to the
 * navigation edge. On small screens the panel spans the viewport width.
 * Focus moves into the panel on open and returns to the trigger on close.
 */
interface Props {
  open: boolean;
  title?: string;
  side?: 'start' | 'end';
  /** 'md' ≈ 26rem, 'lg' ≈ 30rem wide on desktop. */
  size?: 'md' | 'lg';
}

withDefaults(defineProps<Props>(), { title: '', side: 'end', size: 'md' });

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
    <Transition name="app-drawer">
      <div v-if="open" class="app-drawer" @mousedown.self="emit('close')">
        <div
          ref="panel"
          class="app-drawer__panel"
          :class="[`app-drawer__panel--${side}`, `app-drawer__panel--${size}`]"
          role="dialog"
          aria-modal="true"
          :aria-label="title || undefined"
          tabindex="-1"
        >
          <header v-if="title || $slots.header" class="app-drawer__header">
            <slot name="header">
              <h2 class="app-drawer__title">{{ title }}</h2>
            </slot>
            <button
              type="button"
              class="app-drawer__close"
              aria-label="بستن"
              @click="emit('close')"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </header>
          <div class="app-drawer__body">
            <slot />
          </div>
          <footer v-if="$slots.footer" class="app-drawer__footer">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.app-drawer {
  position: fixed;
  inset: 0;
  z-index: var(--z-drawer);
  background: var(--overlay);
  backdrop-filter: blur(2px);
}

.app-drawer__panel {
  position: absolute;
  inset-block: 0;
  display: flex;
  flex-direction: column;
  width: min(100%, 26rem);
  background: var(--surface);
  box-shadow: var(--shadow-overlay);
  outline: none;
}

.app-drawer__panel--lg {
  width: min(100%, 30rem);
}

.app-drawer__panel--start {
  inset-inline-start: 0;
  border-inline-end: 1px solid var(--border);
}

.app-drawer__panel--end {
  inset-inline-end: 0;
  border-inline-start: 1px solid var(--border);
}

.app-drawer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.3rem;
  border-bottom: 1px solid var(--border-subtle);
}

.app-drawer__title {
  font-size: 1rem;
}

.app-drawer__close {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  color: var(--text-3);
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.app-drawer__close:hover {
  background: var(--surface-2);
  color: var(--text-1);
}

.app-drawer__body {
  flex: 1;
  overflow-y: auto;
  padding: 1.2rem 1.3rem;
}

.app-drawer__footer {
  display: flex;
  gap: 0.6rem;
  padding: 0.9rem 1.3rem 1.2rem;
  border-top: 1px solid var(--border-subtle);
}

/* transition — slide along the docked inline edge.
   The hidden translate lives ONLY on enter-from/leave-to; the resting panel
   has no translate, otherwise the panel would slide back out when Vue drops
   the enter-to class after the transition ends. */
.app-drawer-enter-active,
.app-drawer-leave-active {
  transition: opacity var(--motion-normal) var(--ease-out);
}

.app-drawer-enter-active .app-drawer__panel,
.app-drawer-leave-active .app-drawer__panel {
  transition: translate var(--motion-normal) var(--ease-out);
}

.app-drawer-enter-from,
.app-drawer-leave-to {
  opacity: 0;
}

.app-drawer-enter-from .app-drawer__panel--end,
.app-drawer-leave-to .app-drawer__panel--end {
  translate: 100% 0;
}

.app-drawer-enter-from .app-drawer__panel--start,
.app-drawer-leave-to .app-drawer__panel--start {
  translate: -100% 0;
}

/* RTL mirrors the inline edges, so the slide direction flips too. */
[dir='rtl'] .app-drawer-enter-from .app-drawer__panel--end,
[dir='rtl'] .app-drawer-leave-to .app-drawer__panel--end {
  translate: -100% 0;
}

[dir='rtl'] .app-drawer-enter-from .app-drawer__panel--start,
[dir='rtl'] .app-drawer-leave-to .app-drawer__panel--start {
  translate: 100% 0;
}
</style>
