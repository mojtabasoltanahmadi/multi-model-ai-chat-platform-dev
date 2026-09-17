<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  loading?: boolean;
  type?: 'button' | 'submit';
  block?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'primary',
  size: 'md',
  loading: false,
  type: 'button',
  block: false,
});

const isDisabled = computed(() => props.loading);
</script>

<template>
  <button
    :type="type"
    class="app-button"
    :class="[`app-button--${variant}`, `app-button--${size}`, { 'app-button--block': block }]"
    :disabled="isDisabled || undefined"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="app-button__spinner" aria-hidden="true"></span>
    <slot />
  </button>
</template>

<style scoped>
.app-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font-weight: 500;
  white-space: nowrap;
  transition:
    background var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}

.app-button--md {
  height: 2.5rem;
  padding: 0 1.1rem;
  font-size: 0.9rem;
}

.app-button--sm {
  height: 2rem;
  padding: 0 0.75rem;
  font-size: 0.82rem;
}

.app-button--block {
  width: 100%;
}

.app-button--primary {
  background: var(--gradient-primary);
  color: var(--on-accent);
  box-shadow: var(--shadow-glow);
}

/* Gradients don't interpolate; hover reads through brightness + glow lift. */
.app-button--primary:hover:not(:disabled) {
  filter: brightness(1.08);
  box-shadow: var(--shadow-glow-strong);
}

.app-button--primary:active:not(:disabled) {
  filter: brightness(0.96);
  box-shadow: var(--shadow-glow);
}

.app-button--secondary {
  background: var(--surface);
  border-color: var(--border);
  color: var(--text-1);
}

.app-button--secondary:hover:not(:disabled) {
  background: var(--surface-2);
  border-color: var(--border-strong);
}

.app-button--ghost {
  background: transparent;
  color: var(--text-2);
}

.app-button--ghost:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text-1);
}

.app-button--danger {
  background: transparent;
  border-color: var(--danger);
  color: var(--danger);
}

.app-button--danger:hover:not(:disabled) {
  background: var(--danger-soft);
}

.app-button:disabled {
  opacity: 0.55;
}

.app-button__spinner {
  width: 0.9em;
  height: 0.9em;
  border: 2px solid currentcolor;
  border-inline-end-color: transparent;
  border-radius: 50%;
  animation: app-button-spin 0.7s linear infinite;
}

@keyframes app-button-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
