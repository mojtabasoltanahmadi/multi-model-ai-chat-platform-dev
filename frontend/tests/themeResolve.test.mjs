/**
 * Unit checks for the pure theme fallback resolver (src/themes/resolver.ts).
 *
 * There is no frontend test runner in this project, so this script runs the
 * module directly through Node's TypeScript stripping:
 *
 *   node --experimental-strip-types frontend/tests/themeResolve.test.mjs
 *
 * It covers the server-managed availability contract: the user's available
 * preference wins, 'system' follows the OS only while that theme is enabled,
 * everything else falls back to the server default and then the first
 * available theme — and an empty availability list degrades to 'light' so
 * theme tokens are never undefined.
 */
import assert from 'node:assert/strict';
import { resolveTheme } from '../src/themes/resolver.ts';

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

const ALL = ['light', 'dark', 'midnight'];
const defaultOnly = (available, defaultId) => ({ available, defaultId });
const ALL_AVAILABLE = defaultOnly(ALL, 'light');

check('returns the concrete preference while it is available', () => {
  assert.equal(resolveTheme('midnight', ALL_AVAILABLE, false), 'midnight');
});

check("resolves 'system' to the OS scheme (dark)", () => {
  assert.equal(resolveTheme('system', ALL_AVAILABLE, true), 'dark');
});

check("resolves 'system' to light on a light OS scheme", () => {
  assert.equal(resolveTheme('system', ALL_AVAILABLE, false), 'light');
});

check('falls back to the default when the preferred theme was disabled', () => {
  const availability = defaultOnly(['light', 'dark'], 'light');
  assert.equal(resolveTheme('midnight', availability, true), 'light');
});

check("disabled dark does not leak through 'system' — lands on the default", () => {
  const availability = defaultOnly(['light'], 'light');
  assert.equal(resolveTheme('system', availability, true), 'light');
});

check("a 'system' user on a light OS keeps light while light is available", () => {
  const availability = defaultOnly(['midnight', 'light'], 'midnight');
  assert.equal(resolveTheme('system', availability, false), 'light');
});

check("falls back to the OS scheme target for 'system' when the default differs", () => {
  const availability = defaultOnly(['midnight', 'dark'], 'midnight');
  assert.equal(resolveTheme('system', availability, true), 'dark');
});

check('falls back to the server default when the preference is gone entirely', () => {
  const availability = defaultOnly(['dark'], 'dark');
  assert.equal(resolveTheme('midnight', availability, true), 'dark');
});

check('last resort: the first available theme when no default resolves', () => {
  const availability = defaultOnly(['midnight'], null);
  assert.equal(resolveTheme('dark', availability, false), 'midnight');
});

check('an empty availability list degrades to the built-in light theme', () => {
  assert.equal(resolveTheme('dark', defaultOnly([], null), true), 'light');
});

check('an unknown preference id is treated like an unavailable theme', () => {
  const availability = defaultOnly(['light', 'midnight'], 'light');
  assert.equal(resolveTheme('bogus-theme', availability, true), 'light');
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}`);
    console.error(error);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${checks.length} checks failed.`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} checks passed.`);
