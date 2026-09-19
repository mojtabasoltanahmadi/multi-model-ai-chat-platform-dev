import { computed, ref, watchEffect } from 'vue';
import {
  THEME_DEFINITIONS,
  THEME_IDS,
  isThemeId,
  type ThemeId,
  type ThemePreference,
} from '../themes/registry';
import { resolveTheme, type ThemeAvailability } from '../themes/resolver';
import {
  ApiError,
  fetchAvailableThemes,
  fetchMyPreferences,
  updateMyThemePreference,
} from '../api/client';
import type { AvailableTheme } from '../api/types';
import { useToast } from './useToast';

/**
 * Theme state (module singleton, like useAuth/useUsage):
 * - `preference` is the DEVICE-LOCAL choice (may be 'system'), persisted to
 *   localStorage and applied pre-paint by index.html;
 * - `serverThemes` is the admin-controlled availability list — until the
 *   first successful load the full local registry is assumed, so the app
 *   behaves exactly as before the server integration (never worse);
 * - `resolved` is the theme actually painted, produced by the pure resolver:
 *   preference (if available) → 'system' target (if available) → server
 *   default → first available. A theme the admin disables therefore falls
 *   back automatically, on every device.
 *
 * Concrete (non-'system') choices are additionally synced to the server
 * (`user_preferences`), so they survive logout/login and follow the user
 * across devices. 'system' stays device-local by design.
 */

const STORAGE_KEY = 'hooshyar.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

const preference = ref<ThemePreference>(readStoredPreference());

function readStoredPreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'system' || isThemeId(stored)) return stored;
  return 'system';
}

/** null = the server availability list has not loaded yet. */
const serverThemes = ref<AvailableTheme[] | null>(null);

const availability = computed<ThemeAvailability>(() => {
  const list = serverThemes.value;
  if (!list) return { available: THEME_IDS, defaultId: 'light' };
  const available = list.map((theme) => theme.id).filter(isThemeId);
  const defaultTheme = list.find((theme) => theme.isDefault && isThemeId(theme.id));
  // isThemeId has already verified the id; Array.find cannot carry the guard.
  return { available, defaultId: defaultTheme ? (defaultTheme.id as ThemeId) : null };
});

/** OS color-scheme as reactive state (MediaQueryList.matches is not). */
const systemDark = ref(media.matches);
media.addEventListener('change', (event) => {
  systemDark.value = event.matches;
});

/** The theme actually painted right now; always a valid, available theme. */
const resolved = ref<ThemeId>('light');

watchEffect(() => {
  resolved.value = resolveTheme(preference.value, availability.value, systemDark.value);
  document.documentElement.dataset.theme = resolved.value;
});

let syncInflight: Promise<void> | null = null;

/** Loads availability and — when signed in — the server-synced preference. */
function syncServerState(loggedIn: boolean): Promise<void> {
  if (syncInflight) return syncInflight;
  syncInflight = (async () => {
    try {
      serverThemes.value = await fetchAvailableThemes();
    } catch {
      /* keep the local fallback availability (never undefined tokens) */
    }
    if (loggedIn) {
      try {
        const { themeId } = await fetchMyPreferences();
        if (themeId && isThemeId(themeId)) {
          setLocalPreference(themeId);
        }
      } catch {
        /* keep the local preference */
      }
    }
    snapPreferenceToAvailability();
  })();
  return syncInflight.finally(() => {
    syncInflight = null;
  });
}

/** Re-fetches availability (after admin mutations) and re-snapshots. */
async function refreshAvailability(): Promise<void> {
  try {
    serverThemes.value = await fetchAvailableThemes();
  } catch {
    /* keep the last known availability */
  }
  snapPreferenceToAvailability();
}

function setLocalPreference(next: ThemePreference): void {
  preference.value = next;
  localStorage.setItem(STORAGE_KEY, next);
}

/**
 * Fire-and-forget server write for concrete choices. Failure is non-fatal:
 * the local choice stands for this device, and a "disabled by admin" 400
 * triggers an availability re-sync so the UI lands on a valid theme.
 */
async function persistPreference(themeId: ThemeId): Promise<void> {
  try {
    await updateMyThemePreference(themeId);
  } catch (error) {
    if (error instanceof ApiError) {
      useToast().error(`ذخیره پوسته روی حساب کاربری ناموفق بود: ${error.message}`);
    }
    void refreshAvailability();
  }
}

/**
 * If the locally-selected concrete theme is no longer enabled (admin action,
 * stale tab), move the stored preference to the resolved fallback so the
 * selector shows a selectable theme instead of a ghost.
 */
function snapPreferenceToAvailability(): void {
  const current = preference.value;
  if (current !== 'system' && !availability.value.available.includes(current)) {
    setLocalPreference(resolved.value);
  }
}

export function useTheme() {
  const isDark = computed(() => resolved.value !== 'light');

  function setPreference(next: ThemePreference): void {
    setLocalPreference(next);
    if (next !== 'system') {
      void persistPreference(next);
    }
  }

  function toggle(): void {
    setPreference(resolved.value === 'light' ? 'dark' : 'light');
  }

  return {
    preference,
    resolved,
    isDark,
    availability,
    /** Enabled themes as the server ordered them (full registry pre-load). */
    availableThemes: computed(() =>
      availability.value.available.map((id) => THEME_DEFINITIONS[id]),
    ),
    defaultThemeId: computed(() => availability.value.defaultId),
    setPreference,
    toggle,
    syncServerState,
    refreshAvailability,
  };
}
