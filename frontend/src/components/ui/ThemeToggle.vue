<script setup lang="ts">
import { computed } from 'vue';
import { useTheme } from '../../composables/useTheme';
import type { ThemePreference } from '../../themes/registry';
import type { ThemePreview } from '../../themes/registry';

/**
 * Theme selector — ONLY the themes the admin has made available, in the
 * server's display order, plus the device-local 'system' entry. Driven by
 * the availability list from the backend; disabled themes never appear here.
 */
const { preference, availableThemes, setPreference } = useTheme();

interface ToggleOption {
  value: ThemePreference;
  label: string;
  preview: ThemePreview | null;
}

const options = computed<ToggleOption[]>(() => [
  { value: 'system', label: 'سیستم', preview: null },
  ...availableThemes.value.map((theme) => ({
    value: theme.id,
    label: theme.name,
    preview: theme.preview,
  })),
]);
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
      :title="option.label"
      @click="setPreference(option.value)"
    >
      <span
        v-if="option.preview"
        class="theme-toggle__swatch"
        :style="{
          background: option.preview.surface,
          borderColor: option.preview.border,
        }"
        aria-hidden="true"
      >
        <span
          class="theme-toggle__swatch-dot"
          :style="{ background: option.preview.accent }"
        ></span>
      </span>
      {{ option.label }}
      <svg
        v-if="preference === option.value"
        class="theme-toggle__check"
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m5 13 4 4L19 7" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.theme-toggle {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 3px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.theme-toggle__option {
  display: inline-flex;
  align-items: center;
  gap: 0.34rem;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-2);
  font-size: 0.74rem;
  padding: 0.22rem 0.5rem;
  border-radius: var(--radius-xs);
  white-space: nowrap;
  transition:
    background var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.theme-toggle__option:hover {
  color: var(--text-1);
}

.theme-toggle__option:focus-visible {
  outline: 2px solid var(--focus-border);
  outline-offset: 1px;
}

.theme-toggle__option--active,
.theme-toggle__option--active:hover {
  background: var(--accent-soft);
  border-color: var(--accent-soft-border);
  color: var(--text-1);
}

.theme-toggle__swatch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 0.85rem;
  height: 0.85rem;
  border-radius: 3px;
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.theme-toggle__swatch-dot {
  width: 0.34rem;
  height: 0.34rem;
  border-radius: var(--radius-full);
}

.theme-toggle__check {
  color: var(--accent-text);
}
</style>
