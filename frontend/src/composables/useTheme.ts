import { computed, ref, watchEffect } from 'vue';

export type ThemePreference = 'light' | 'dark' | 'midnight' | 'system';

const STORAGE_KEY = 'hooshyar.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

const preference = ref<ThemePreference>(readStoredPreference());

function readStoredPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'midnight' || stored === 'system') {
    return stored;
  }
  return 'system';
}

/** The theme actually painted right now (resolves 'system'; 'midnight' is always explicit). */
const resolved = ref<'light' | 'dark' | 'midnight'>('light');

watchEffect(() => {
  resolved.value =
    preference.value === 'system'
      ? media.matches
        ? 'dark'
        : 'light'
      : preference.value;
  document.documentElement.dataset.theme = resolved.value;
});

// Follow OS changes while on 'system'.
media.addEventListener('change', () => {
  if (preference.value === 'system') {
    resolved.value = media.matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = resolved.value;
  }
});

export function useTheme() {
  const isDark = computed(() => resolved.value !== 'light');

  function setPreference(next: ThemePreference): void {
    preference.value = next;
    localStorage.setItem(STORAGE_KEY, next);
  }

  function toggle(): void {
    setPreference(resolved.value === 'light' ? 'dark' : 'light');
  }

  return { preference, resolved, isDark, setPreference, toggle };
}
