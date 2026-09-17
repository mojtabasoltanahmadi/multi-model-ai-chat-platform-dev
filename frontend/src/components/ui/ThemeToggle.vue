<script setup lang="ts">
import { useTheme, type ThemePreference } from '../../composables/useTheme';

const { preference, setPreference } = useTheme();

const options: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'روشن' },
  { value: 'system', label: 'سیستم' },
  { value: 'dark', label: 'تاریک' },
  { value: 'midnight', label: 'نیم‌شب' },
];
</script>

<template>
  <div class="theme-toggle" role="radiogroup" aria-label="انتخاب پوسته">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      role="radio"
      class="theme-toggle__option"
      :class="{ 'theme-toggle__option--active': preference === option.value }"
      :aria-checked="preference === option.value"
      @click="setPreference(option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.theme-toggle {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.theme-toggle__option {
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 0.74rem;
  padding: 0.28rem 0.52rem;
  border-radius: var(--radius-xs);
  white-space: nowrap;
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.theme-toggle__option:hover {
  color: var(--text-1);
}

.theme-toggle__option--active {
  background: var(--surface);
  color: var(--text-1);
  box-shadow: var(--shadow-1);
}
</style>
