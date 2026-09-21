/**
 * Unit checks for the rehydration rule that decides which files re-appear as
 * composer chips when a conversation loads.
 *
 * There is no frontend test runner in this project, so this script runs the
 * module directly through Node's TypeScript stripping:
 *
 *   node --experimental-strip-types frontend/tests/fileRestore.test.mjs
 *
 * It covers the persistence rules the chat UI relies on: a file the user
 * picked but never sent survives a refresh in every status, a file consumed
 * by a sent message never returns as a chip, and multi-file conversations
 * are classified independently.
 */
import assert from 'node:assert/strict';
import { draftFilesForRestore } from '../src/utils/fileRestore.ts';

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

function file(id, status) {
  return {
    id,
    userId: 'user-1',
    conversationId: 'conv-1',
    originalName: `${id}.pdf`,
    mimeType: 'application/pdf',
    size: 10,
    status,
    errorMessage: status === 'FAILED' ? 'خطا' : null,
    attempts: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function message(id, attachedFileIds) {
  return { id, attachedFileIds };
}

check('a READY-but-unsent file is restored as a draft (survives refresh)', () => {
  const files = [file('f-1', 'READY')];
  const restored = draftFilesForRestore(files, []);
  assert.deepEqual(restored.map((f) => f.id), ['f-1']);
});

check('a file consumed by a sent message is NOT restored as a chip', () => {
  const files = [file('f-1', 'READY')];
  const messages = [message('m-1', ['f-1'])];
  assert.deepEqual(draftFilesForRestore(files, messages), []);
});

check('files still UPLOADING or PROCESSING are restored with their persisted status', () => {
  const files = [file('f-1', 'UPLOADING'), file('f-2', 'PROCESSING')];
  const restored = draftFilesForRestore(files, []);
  assert.deepEqual(restored.map((f) => f.status), ['UPLOADING', 'PROCESSING']);
});

check('a FAILED file is restored so its reason and retry stay reachable', () => {
  const files = [file('f-1', 'FAILED')];
  const restored = draftFilesForRestore(files, []);
  assert.deepEqual(restored.map((f) => f.status), ['FAILED']);
});

check('consumed and unconsumed files are classified independently', () => {
  const files = [
    file('sent-1', 'READY'),
    file('draft-1', 'READY'),
    file('sent-2', 'READY'),
    file('draft-2', 'FAILED'),
  ];
  const messages = [message('m-1', ['sent-1']), message('m-2', ['sent-2'])];
  assert.deepEqual(draftFilesForRestore(files, messages).map((f) => f.id), [
    'draft-1',
    'draft-2',
  ]);
});

check('a message without attachments consumes nothing', () => {
  const files = [file('f-1', 'READY')];
  const messages = [message('m-1', null), message('m-2', [])];
  assert.equal(draftFilesForRestore(files, messages).length, 1);
});

check('multiple messages referencing the same file still exclude it once', () => {
  const files = [file('f-1', 'READY'), file('f-2', 'PROCESSING')];
  const messages = [message('m-1', ['f-1']), message('m-2', ['f-1'])];
  assert.deepEqual(draftFilesForRestore(files, messages).map((f) => f.id), ['f-2']);
});

check('an empty conversation has nothing to restore', () => {
  assert.deepEqual(draftFilesForRestore([], []), []);
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${name}`);
    console.error(error?.message ?? error);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
