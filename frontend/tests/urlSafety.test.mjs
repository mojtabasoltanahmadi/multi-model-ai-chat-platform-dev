/**
 * Unit checks for external-source URL safety.
 *
 * Same runner convention as uploadQueue.test.mjs (no test framework):
 *
 *   node --experimental-strip-types frontend/tests/urlSafety.test.mjs
 *
 * Covers: only http(s) links are accepted, hostile schemes are rejected,
 * and the display domain is re-derived from the URL itself.
 */
import assert from 'node:assert/strict';
import { isSafeExternalUrl, safeDomainOf } from '../src/utils/urlSafety.ts';

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

check('accepts absolute http/https URLs', () => {
  assert.equal(isSafeExternalUrl('https://react.dev/blog'), true);
  assert.equal(isSafeExternalUrl('http://example.com/x?q=1'), true);
});

check('rejects hostile and non-absolute URLs', () => {
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  assert.equal(isSafeExternalUrl('JaVaScRiPt:alert(1)'), false);
  assert.equal(isSafeExternalUrl('data:text/html,<h1>x</h1>'), false);
  assert.equal(isSafeExternalUrl('ftp://example.com/f'), false);
  assert.equal(isSafeExternalUrl('/relative/path'), false);
  assert.equal(isSafeExternalUrl(''), false);
  assert.equal(isSafeExternalUrl(null), false);
  assert.equal(isSafeExternalUrl(undefined), false);
  assert.equal(isSafeExternalUrl(42), false);
});

check('derives the lowercase host, with fallback for unsafe input', () => {
  assert.equal(safeDomainOf('https://React.Dev/Blog', 'fallback'), 'react.dev');
  assert.equal(safeDomainOf('javascript:alert(1)', 'fallback'), 'fallback');
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(error);
  }
}
if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
} else {
  console.log(`${checks.length} checks passed`);
}
