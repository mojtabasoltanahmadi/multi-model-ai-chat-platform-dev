<script setup lang="ts">
import { computed, ref, useId } from 'vue';

interface Props {
  modelValue: string;
  label: string;
  type?: 'text' | 'email' | 'password';
  autocomplete?: string;
  placeholder?: string;
  dir?: 'rtl' | 'ltr' | 'auto';
  error?: string;
  hint?: string;
  required?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  type: 'text',
  dir: 'rtl',
});

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const inputId = useId();
const errorId = useId();
const revealing = ref(false);

const actualType = computed(() => {
  if (props.type !== 'password') return props.type;
  return revealing.value ? 'text' : 'password';
});

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="app-field">
    <label :for="inputId" class="app-field__label">
      {{ label }}
      <span v-if="required" class="app-field__required" aria-hidden="true">*</span>
    </label>
    <div class="app-field__control" :class="{ 'app-field__control--invalid': error }">
      <input
        :id="inputId"
        :type="actualType"
        class="app-field__input"
        :class="{ ltr: dir === 'ltr' }"
        :dir="dir"
        :value="modelValue"
        :placeholder="placeholder"
        :autocomplete="autocomplete"
        :required="required"
        :aria-invalid="error ? true : undefined"
        :aria-describedby="error ? errorId : undefined"
        @input="onInput"
      />
      <button
        v-if="type === 'password'"
        type="button"
        class="app-field__reveal"
        :aria-label="revealing ? 'پنهان کردن رمز' : 'نمایش رمز'"
        :title="revealing ? 'پنهان کردن رمز' : 'نمایش رمز'"
        @click="revealing = !revealing"
      >
        <svg v-if="!revealing" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M2 12s3.5-7 10-7c2.1 0 3.9.7 5.4 1.6M22 12s-3.5 7-10 7c-2.1 0-3.9-.7-5.4-1.6" />
          <path d="m4 20 16-16" />
        </svg>
      </button>
    </div>
    <p v-if="error" :id="errorId" class="app-field__error" role="alert">{{ error }}</p>
    <p v-else-if="hint" class="app-field__hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.app-field {
  display: grid;
  gap: 0.4rem;
}

.app-field__label {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-2);
}

.app-field__required {
  color: var(--danger);
}

.app-field__control {
  position: relative;
  display: flex;
}

.app-field__input {
  width: 100%;
  height: 2.75rem;
  padding: 0 0.9rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  outline: none;
  font-size: 0.9rem;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}

.app-field__control:has(.app-field__reveal) .app-field__input {
  padding-inline-end: 2.6rem;
}

.app-field__input::placeholder {
  color: var(--text-3);
}

.app-field__input:focus {
  border-color: var(--focus-border);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.app-field__control--invalid .app-field__input {
  border-color: var(--danger);
}

.app-field__control--invalid .app-field__input:focus {
  box-shadow: 0 0 0 3px var(--danger-soft);
}

.app-field__input.ltr {
  text-align: left;
}

.app-field__reveal {
  position: absolute;
  inset-inline-end: 0.35rem;
  top: 50%;
  translate: 0 -50%;
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  color: var(--text-3);
}

.app-field__reveal:hover {
  color: var(--text-1);
  background: var(--surface-2);
}

.app-field__error {
  font-size: 0.78rem;
  color: var(--danger);
}

.app-field__hint {
  font-size: 0.78rem;
  color: var(--text-3);
}
</style>
