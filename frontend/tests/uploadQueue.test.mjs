/**
 * Unit checks for the sequential upload queue.
 *
 * There is no frontend test runner in this project, so this script runs the
 * module directly through Node's TypeScript stripping:
 *
 *   node --experimental-strip-types frontend/tests/uploadQueue.test.mjs
 *
 * It covers the ordering rules that the chat UI relies on: one file at a time,
 * pick order preserved, a failure halts the queue, retry resumes it, and no
 * upload is ever duplicated.
 */
import assert from 'node:assert/strict';
import { createUploadQueue } from '../src/utils/uploadQueue.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets queued microtasks (the queue's internal promise chain) run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

check('uploads strictly one file at a time, in pick order', async () => {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const gates = new Map();
  const queue = createUploadQueue(async (item) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls.push(`start:${item.id}`);
    const gate = deferred();
    gates.set(item.id, gate);
    await gate.promise;
    inFlight -= 1;
    calls.push(`end:${item.id}`);
  });

  queue.enqueue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  await tick();
  assert.deepEqual(calls, ['start:a'], 'only the first file may start');

  gates.get('a').resolve();
  await tick();
  assert.deepEqual(calls, ['start:a', 'end:a', 'start:b'], 'b starts only after a finished');

  gates.get('b').resolve();
  await tick();
  gates.get('c').resolve();
  await tick();

  assert.deepEqual(calls, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  assert.equal(maxInFlight, 1, 'never two parallel uploads');
  assert.equal(queue.waiting, 0);
  assert.equal(queue.running, false);
});

check('a failure halts the queue and leaves the rest waiting', async () => {
  const started = [];
  const queue = createUploadQueue(async (item) => {
    started.push(item.id);
    if (item.id === 'b') throw new Error('upload failed');
  });

  queue.enqueue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  await tick();
  await tick();

  assert.deepEqual(started, ['a', 'b'], 'c must not start behind the failure');
  assert.equal(queue.waiting, 1, 'only c is still waiting (b was handed back)');
  assert.equal(queue.running, false);
});

check('retry sends the failed file first, then continues in order', async () => {
  const started = [];
  let failFirstB = true;
  const queue = createUploadQueue(async (item) => {
    started.push(item.id);
    if (item.id === 'b' && failFirstB) {
      failFirstB = false;
      throw new Error('upload failed');
    }
  });

  queue.enqueue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  await tick();
  await tick();
  assert.deepEqual(started, ['a', 'b']);

  queue.retry({ id: 'b' });
  await tick();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'b', 'c'], 'retry first, then the file behind it');

  // A second retry of a file that is no longer waiting is a no-op.
  queue.retry({ id: 'b' });
  await tick();
  assert.deepEqual(started, ['a', 'b', 'b', 'c']);
});

check('dropping the failed file resumes the files behind it', async () => {
  const started = [];
  const queue = createUploadQueue(async (item) => {
    started.push(item.id);
    if (item.id === 'b') throw new Error('upload failed');
  });

  queue.enqueue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  await tick();
  await tick();
  assert.deepEqual(started, ['a', 'b']);

  queue.drop('b');
  await tick();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c']);
  assert.equal(queue.waiting, 0);
});

check('dropping a file that is still waiting never starts it', async () => {
  const started = [];
  const gate = deferred();
  const queue = createUploadQueue(async (item) => {
    started.push(item.id);
    if (item.id === 'a') await gate.promise;
  });

  queue.enqueue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  await tick();
  queue.drop('b');
  gate.resolve();
  await tick();
  await tick();
  assert.deepEqual(started, ['a', 'c']);
});

check('removing the file being uploaded keeps the queue moving', async () => {
  const started = [];
  const gate = deferred();
  const queue = createUploadQueue(async (item) => {
    started.push(item.id);
    if (item.id === 'a') await gate.promise;
  });

  queue.enqueue([{ id: 'a' }, { id: 'b' }]);
  await tick();
  assert.deepEqual(started, ['a']);

  // The user removed the chip while its transfer was running: the upload still
  // finishes (the view discards the result), and b must not be skipped.
  queue.drop('a');
  gate.resolve();
  await tick();
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  assert.equal(queue.waiting, 0);
  assert.equal(queue.running, false);
});

check('reset forgets queued files while the in-flight upload finishes', async () => {
  const started = [];
  let settled = 0;
  const gate = deferred();
  const queue = createUploadQueue(async (item) => {
    started.push(item.id);
    if (item.id === 'a') await gate.promise;
    settled += 1;
  });

  queue.enqueue([{ id: 'a' }, { id: 'b' }]);
  await tick();
  queue.reset();
  gate.resolve();
  await tick();
  await tick();

  assert.deepEqual(started, ['a'], 'b must be forgotten');
  assert.equal(settled, 1, 'the in-flight upload still completes');
  assert.equal(queue.running, false);
  assert.equal(queue.waiting, 0);
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\n${checks.length - failed}/${checks.length} upload-queue checks passed.`);
if (failed > 0) process.exit(1);
