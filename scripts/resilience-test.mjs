/**
 * Live resilience scenarios — exercises the detached-generation contract
 * end-to-end. Not a Jest test; this is the manual-test pass scripted so it
 * can be re-run.
 *
 *   node scripts/resilience-test.mjs
 *
 * Requires backend on :4000 (mock provider is fine — no API key needed).
 *
 * Core invariants under test:
 *   - client disconnect ≠ generation failure: the AI keeps generating and
 *     the row ends 'completed', never 'interrupted', after a client abort;
 *   - the reconnect endpoint replays the existing generation (snapshot +
 *     remaining deltas + terminal) without ever re-invoking the AI;
 *   - snapshot + deltas concatenate EXACTLY to the persisted content
 *     (no duplicated or missing tokens);
 *   - one logical request → exactly one user row + one assistant row;
 *   - ownership is enforced on the reconnect endpoint.
 */

const BASE = process.env.API_BASE ?? 'http://localhost:4000/api';
let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* non-JSON */
  }
  return { status: r.status, json };
}

/** Collects SSE events from a fetch Response into an array (mutated live). */
function collectSSE(response, events) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const done = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep !== -1) {
        const block = buf.slice(0, sep);
        const event = block.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
        const data = block.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
        if (event && data) {
          try {
            events.push({ event, data: JSON.parse(data) });
          } catch {
            /* malformed block */
          }
        }
        buf = buf.slice(sep + 2);
        sep = buf.indexOf('\n\n');
      }
    }
  })();
  return { events, finished: done };
}

/** Opens the POST chat stream. Resolves once headers arrive; events fill `events`. */
async function openStream(token, conversationId, body, { signal } = {}) {
  const r = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal,
  });
  const events = [];
  const collector = collectSSE(r, events);
  return { status: r.status, events, collector };
}

/** Opens the GET reconnect/recovery stream. */
async function openReconnect(token, conversationId, messageId) {
  const r = await fetch(
    `${BASE}/conversations/${conversationId}/messages/${messageId}/stream`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const events = [];
  const collector = collectSSE(r, events);
  return { status: r.status, events, collector };
}

/** Runs a full POST stream to its terminal event. */
async function stream(token, conversationId, body) {
  const handle = await openStream(token, conversationId, body);
  await handle.collector.finished;
  return handle;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const uniq = Date.now();
const reg = await api('POST', '/auth/register', { body: { email: `resil-${uniq}@x.com`, password: 'password123' } });
const token = reg.json.accessToken;
const conv = await api('POST', '/conversations', { token, body: {} });
const convId = conv.json.id;

// ----- 1: client disconnect mid-stream ≠ generation failure -----
console.log('\n[1] Abort mid-stream: generation continues, row completes');
const cmid1 = `cmid-${uniq}-1`;
const ctl1 = new AbortController();
// The mock provider sleeps 40ms between chunks; abort after several chunks
// have been delivered (~250ms) so the partial-content assertion is
// meaningful regardless of localhost network jitter.
setTimeout(() => ctl1.abort(), 250);
try {
  await stream(token, convId, { content: 'یک پیام بلند برای آزمایش قطع ارتباط', clientMessageId: cmid1 }, { signal: ctl1.signal });
} catch {
  /* expected: aborted fetch */
}
// The detached generation keeps running after the abort; give it time to
// reach its terminal persisted state.
await sleep(1500);
const after1 = await api('GET', `/conversations/${convId}`, { token });
const assistant1 = after1.json.messages.filter((m) => m.role === 'assistant').at(-1);
check('detached generation COMPLETES after client abort', assistant1?.status === 'completed', `status=${assistant1?.status}`);
check('full content persisted (not a partial)', typeof assistant1?.content === 'string' && assistant1.content.length > 100, `len=${assistant1?.content?.length}`);
check('no error message on the row', assistant1?.errorMessage === null || assistant1?.errorMessage === undefined || assistant1?.errorMessage === '');
check('user row persisted before the abort', after1.json.messages.some((m) => m.role === 'user' && m.clientMessageId === cmid1));

// ----- 2: reconnect endpoint replays a COMPLETED row without regenerating -----
console.log('\n[2] Reconnect on completed row: snapshot + done, no regeneration');
const rec2 = await openReconnect(token, convId, assistant1.id);
await rec2.collector.finished;
const snap2 = rec2.events.find((e) => e.event === 'snapshot');
const done2 = rec2.events.find((e) => e.event === 'done');
check('reconnect on completed row returns 200', rec2.status === 200);
check('snapshot carries the full persisted content', snap2?.data.assistantMessage?.content === assistant1.content);
check('terminal event is done with status=completed', done2?.data.assistantMessage?.status === 'completed');
const after2rows = await api('GET', `/conversations/${convId}`, { token });
const assistantRows2 = after2rows.json.messages.filter((m) => m.role === 'assistant');
check('replay did NOT create another assistant row', assistantRows2.length === 1, `found ${assistantRows2.length}`);

// ----- 3: reconnect to a LIVE generation: snapshot + remaining deltas -----
console.log('\n[3] Second client attaches to a live generation');
const cmid3 = `cmid-${uniq}-3`;
const live = await openStream(token, convId, { content: 'پاسخی بلند برای اتصال همزمان دو کلاینت', clientMessageId: cmid3 });
// The meta event lands just after the fetch resolves — poll briefly for it
// before attaching the shadow client.
let meta3 = live.events.find((e) => e.event === 'meta');
for (let i = 0; i < 50 && !meta3; i++) {
  await sleep(20);
  meta3 = live.events.find((e) => e.event === 'meta');
}
check('meta carries the pre-persisted assistant row', /^[0-9a-f-]{36}$/i.test(meta3?.data.assistantMessage?.id ?? ''));
const liveMessageId = meta3?.data.assistantMessage?.id;
// Attach once deltas are flowing (~120ms in) so the snapshot is non-trivial.
await sleep(120);
let shadow = null;
if (liveMessageId) {
  shadow = await openReconnect(token, convId, liveMessageId);
}
if (shadow) {
  await Promise.all([live.collector.finished, shadow.collector.finished]);
} else {
  await live.collector.finished.catch(() => {});
}
const shadowSnap = shadow?.events.find((e) => e.event === 'snapshot');
const shadowDeltas = (shadow?.events ?? [])
  .filter((e) => e.event === 'delta')
  .map((e) => e.data.text);
const shadowDone = shadow?.events.find((e) => e.event === 'done');
const liveDone = live.events.find((e) => e.event === 'done');
const shadowJoined = shadowSnap !== undefined;
check('shadow client received a snapshot', shadowJoined, shadow ? '' : 'no meta — could not attach');
if (shadowJoined) {
  const shadowTotal = shadowSnap.data.assistantMessage.content + shadowDeltas.join('');
  check('snapshot + remaining deltas = full content (no dup/missing tokens)',
    shadowTotal === liveDone?.data.assistantMessage?.content,
    `shadow=${shadowTotal.length} final=${liveDone?.data.assistantMessage?.content?.length}`);
  check('snapshot is a strict prefix of the final content',
    liveDone?.data.assistantMessage?.content.startsWith(shadowSnap.data.assistantMessage.content));
  check('shadow client got the same terminal row', shadowDone?.data.assistantMessage?.id === liveDone?.data.assistantMessage?.id);
}
check('original client completed normally', liveDone?.data.assistantMessage?.status === 'completed');
const after3 = await api('GET', `/conversations/${convId}`, { token });
const assistantRows3 = after3.json.messages.filter((m) => m.role === 'assistant');
check('two clients, ONE generation, ONE assistant row for the turn', assistantRows3.length === 2, `found ${assistantRows3.length}`);

// ----- 4: reconnect ownership enforcement -----
console.log('\n[4] Reconnect rejects foreign messages');
const stranger = await api('POST', '/auth/register', { body: { email: `resil-stranger-${uniq}@x.com`, password: 'password123' } });
if (liveMessageId) {
const recForeign = await openReconnect(stranger.json.accessToken, convId, liveMessageId);
await recForeign.collector.finished.catch(() => {});
check('foreign reconnect is rejected with 404', recForeign.status === 404);
} else {
  check('foreign reconnect is rejected with 404', false, 'no meta — could not attach');
}
const recUnknown = await openReconnect(token, convId, '00000000-0000-4000-8000-000000000000');
check('unknown message reconnect is rejected with 404', recUnknown.status === 404);

// ----- 5: retry reuses the user row -----
console.log('\n[5] Retry (replay) semantics');
const retry1 = await stream(token, convId, { content: 'یک پیام بلند برای آزمایش قطع ارتباط', clientMessageId: cmid1 });
check('retry emits replay=true', retry1.events[0]?.data.replay === true);
check('retry reuses same user row id',
  retry1.events[0]?.data.userMessage.id === after1.json.messages.find((m) => m.role === 'user' && m.clientMessageId === cmid1)?.id);
const after5 = await api('GET', `/conversations/${convId}`, { token });
const userRows5 = after5.json.messages.filter((m) => m.role === 'user' && m.clientMessageId === cmid1);
check('retry did NOT duplicate the user row', userRows5.length === 1, `found ${userRows5.length}`);
const assistants5 = after5.json.messages.filter((m) => m.role === 'assistant');
check('retry created exactly one new assistant row', assistants5.length === 3, `found ${assistants5.length}`);
check('new assistant row completed', assistants5.at(-1)?.status === 'completed');

// ----- 6: status state machine (pending → completed via meta/done) -----
console.log('\n[6] Pre-persist pending assistant row');
const cmid6 = `cmid-${uniq}-6`;
const s6 = await stream(token, convId, { content: 'سلام', clientMessageId: cmid6 });
const meta6 = s6.events[0]?.data;
check('meta.assistantMessage.id is a real UUID', /^[0-9a-f-]{36}$/i.test(meta6?.assistantMessage?.id ?? ''));
check('meta.assistantMessage.status starts at pending', meta6?.assistantMessage?.status === 'pending');
check('final done event has status=completed', s6.events.at(-1)?.data.assistantMessage?.status === 'completed');

// ----- 7: Idempotency-Key header -----
console.log('\n[7] Idempotency-Key header accepted');
const cmid7 = `cmid-${uniq}-7`;
const r7a = await fetch(`${BASE}/conversations/${convId}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': cmid7 },
  body: JSON.stringify({ content: 'پیام از طریق هدر' }),
});
const ev7a = [];
await collectSSE(r7a, ev7a).finished;
check('header turn has replay=false on first call', ev7a[0]?.data.replay === false);
const r7b = await fetch(`${BASE}/conversations/${convId}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': cmid7 },
  body: JSON.stringify({ content: 'پیام از طریق هدر' }),
});
const ev7b = [];
await collectSSE(r7b, ev7b).finished;
check('header second call has replay=true', ev7b[0]?.data.replay === true);

// ----- 8: pre-delta disconnect still completes -----
console.log('\n[8] Abort BEFORE the first delta: no rows are created');
const before8 = await api('GET', `/conversations/${convId}`, { token });
const before8Rows = before8.json.messages.length;
const cmid8 = `cmid-${uniq}-8`;
const ctl8 = new AbortController();
ctl8.abort(); // abort before the request is even sent
try {
  await openStream(token, convId, { content: 'قطع پیش از اولین توکن', clientMessageId: cmid8 }, { signal: ctl8.signal });
} catch {
  /* expected */
}
const after8 = await api('GET', `/conversations/${convId}`, { token });
const user8 = after8.json.messages.find((m) => m.role === 'user' && m.clientMessageId === cmid8);
check('aborted-before-send request creates no rows', user8 === undefined && after8.json.messages.length === before8Rows, `before=${before8Rows} after=${after8.json.messages.length}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
