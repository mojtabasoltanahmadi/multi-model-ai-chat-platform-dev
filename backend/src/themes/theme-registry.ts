/**
 * Server-side theme registry — the closed set of theme ids the frontend knows
 * how to render (each id maps to a `:root[data-theme='…']` token block in
 * `frontend/src/styles/tokens.css` and an entry in
 * `frontend/src/themes/registry.ts`).
 *
 * Availability (enabled / default / order / display names) lives in the
 * `themes` table and is admin-controlled. This constant is the validation
 * boundary: unknown ids never reach the database or the preference endpoints,
 * so user input can never inject a theme.
 *
 * Adding a theme = a new token block + client registry entry + a seed here.
 * Existing installations pick the row up on the next boot (seed-on-init).
 */

export type ThemeId = 'light' | 'dark' | 'midnight';

export const THEME_IDS: readonly ThemeId[] = ['light', 'dark', 'midnight'];

export interface ThemeSeed {
  id: ThemeId;
  name: string;
  description: string;
  /** Initial display order; admins reorder freely afterwards. */
  sortOrder: number;
}

export const THEME_REGISTRY: readonly ThemeSeed[] = [
  {
    id: 'light',
    name: 'روشن',
    description: 'پوسته پیش‌فرض روشن با هویت سرمه‌ای-بنفش MultiAI.',
    sortOrder: 1,
  },
  {
    id: 'dark',
    name: 'شبانه',
    description: 'پوسته تیره سرمه‌ای با سطوح آبی‌رنگ و درخشش ملایم.',
    sortOrder: 2,
  },
  {
    id: 'midnight',
    name: 'نیم‌شب',
    description: 'پوسته تیره خنثیِ زغالی با حداقل نویز بصری و تأکید آبی/بنفش.',
    sortOrder: 3,
  },
];

export function isKnownThemeId(value: string): value is ThemeId {
  return (THEME_IDS as readonly string[]).includes(value);
}
