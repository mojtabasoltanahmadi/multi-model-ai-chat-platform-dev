import type { ThemeId, ThemePreference } from './registry';

/**
 * Server-controlled availability: the enabled themes in display order plus
 * the flagged default. Before the first successful load the caller passes
 * the full local registry, so the app works identically offline.
 */
export interface ThemeAvailability {
  /** Enabled theme ids in server display order. */
  available: readonly ThemeId[];
  /** The flagged default theme (member of `available` when non-empty). */
  defaultId: ThemeId | null;
}

/**
 * Pure fallback resolution (spec: preference → default → first available →
 * safe local default). Runs entirely on ids so it is unit-testable and
 * DOM-free; `useTheme` applies the result to `data-theme`.
 *
 * - a concrete preference that is still available wins;
 * - 'system' resolves to the OS scheme but only if that theme is enabled —
 *   a disabled dark theme must not shadow the admin's decision;
 * - everything else lands on the server default, then the first available;
 * - an unknown/empty availability list degrades to 'light' so tokens are
 *   never undefined.
 */
export function resolveTheme(
  preference: ThemePreference,
  availability: ThemeAvailability,
  systemPrefersDark: boolean,
): ThemeId {
  const { available, defaultId } = availability;
  if (available.length === 0) return 'light';

  if (preference !== 'system' && available.includes(preference)) {
    return preference;
  }
  const systemTarget: ThemeId = systemPrefersDark ? 'dark' : 'light';
  if (preference === 'system' && available.includes(systemTarget)) {
    return systemTarget;
  }
  if (defaultId && available.includes(defaultId)) {
    return defaultId;
  }
  return available[0];
}
