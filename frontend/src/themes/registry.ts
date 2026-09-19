/**
 * Client-side theme registry — visual metadata for every theme id this app
 * can render. The SERVER decides which of these users may pick (admin-managed
 * `themes` table via GET /api/themes/available); this file decides what each
 * one looks like: display fallbacks when the API is unreachable and preview
 * palettes for the theme selector and the admin preview cards.
 *
 * Adding a theme (3 places, all keyed by the same id):
 *   1. a `:root[data-theme='…']` token block in `src/styles/tokens.css`
 *   2. an entry in `THEME_DEFINITIONS` here
 *   3. a seed row in `backend/src/themes/theme-registry.ts`
 */

export type ThemeId = 'light' | 'dark' | 'midnight';

/** A theme preference: a concrete theme, or follow the OS ('system'). */
export type ThemePreference = ThemeId | 'system';

/** Flat palette used to draw the mini preview mockups (theme-agnostic). */
export interface ThemePreview {
  /** Page / sidebar background of the mockup. */
  bg: string;
  /** Primary content surface. */
  surface: string;
  /** Composer / secondary surface. */
  surface2: string;
  border: string;
  text: string;
  text2: string;
  /** Brand accent and the second stop of the primary gradient. */
  accent: string;
  accent2: string;
}

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  description: string;
  preview: ThemePreview;
}

export const THEME_DEFINITIONS: Record<ThemeId, ThemeDefinition> = {
  light: {
    id: 'light',
    name: 'روشن',
    description: 'پوسته پیش‌فرض روشن با هویت سرمه‌ای-بنفش MultiAI.',
    preview: {
      bg: '#f7f7f4',
      surface: '#ffffff',
      surface2: '#f1f0ec',
      border: '#e4e3de',
      text: '#1a1d23',
      text2: '#5c6370',
      accent: '#4f46e5',
      accent2: '#7c3aed',
    },
  },
  dark: {
    id: 'dark',
    name: 'شبانه',
    description: 'پوسته تیره سرمه‌ای با سطوح آبی‌رنگ و درخشش ملایم.',
    preview: {
      bg: '#060b1d',
      surface: '#0b142b',
      surface2: '#101b39',
      border: '#1d2a55',
      text: '#e9edfc',
      text2: '#9aa6cc',
      accent: '#6366f1',
      accent2: '#8b5cf6',
    },
  },
  midnight: {
    id: 'midnight',
    name: 'نیم‌شب',
    description: 'پوسته تیره خنثیِ زغالی با حداقل نویز بصری و تأکید آبی/بنفش.',
    preview: {
      bg: '#0b0d0f',
      surface: '#111315',
      surface2: '#17191c',
      border: 'rgba(255, 255, 255, 0.1)',
      text: '#f5f5f5',
      text2: '#b4b7bc',
      accent: '#3b82f6',
      accent2: '#8b5cf6',
    },
  },
};

export const THEME_IDS: readonly ThemeId[] = Object.keys(THEME_DEFINITIONS) as ThemeId[];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && value in THEME_DEFINITIONS;
}
