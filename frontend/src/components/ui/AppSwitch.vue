<script setup lang="ts">
/**
 * Accessible toggle switch (reference "وضعیت" toggles).
 * Track turns brand gradient when on; knob uses logical properties so it
 * flips correctly in RTL.
 */
interface Props {
  modelValue: boolean;
  /** Accessible name — the switch has no visible text of its own. */
  label: string;
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), { disabled: false });
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

function toggle() {
  if (!props.disabled) emit('update:modelValue', !props.modelValue);
}
</script>

<template>
  <button
    type="button"
    class="app-switch"
    :class="{ 'app-switch--on': modelValue }"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="app-switch__knob" aria-hidden="true"></span>
  </button>
</template>

<style scoped>
.app-switch {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
  width: 2.4rem;
  height: 1.35rem;
  padding: 0;
  background: var(--surface-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-full);
  transition:
    background var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}

.app-switch--on {
  background: var(--gradient-primary);
  border-color: transparent;
  box-shadow: var(--shadow-glow);
}

.app-switch__knob {
  position: absolute;
  top: 50%;
  inset-inline-start: 0.14rem;
  translate: 0 -50%;
  width: 1rem;
  height: 1rem;
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: var(--shadow-1);
  transition: inset-inline-start var(--motion-fast) var(--ease-out);
}

.app-switch--on .app-switch__knob {
  inset-inline-start: calc(100% - 1.14rem);
}

.app-switch:disabled {
  cursor: not-allowed;
}

/* A locked-ON switch (default model) must still read as ON — mute it via
   desaturation instead of opacity, which would make the gradient look OFF. */
.app-switch--on:disabled {
  filter: saturate(0.45) brightness(0.72);
  box-shadow: none;
}
</style>
