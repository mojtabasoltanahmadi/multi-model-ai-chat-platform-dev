/**
 * E2E fallback / graceful-degradation test (day-7-8 contract §12, §9).
 *
 * REQUIRES a backend started with the platform search switch ON and NO
 * search provider key (the degrade path is exercised, not live search):
 *   PORT=4100 \
 *   WEB_SEARCH_ENABLED=true \
 *   npm run start:dev
 * Then: node scripts/fallback-resilience-test.mjs
 * (API_BASE env overrides the target)
 *
 * Covers: execution-phase narration (thinking → generating), the single-hop
 * fallback (retryable pre-delta failure → fallback model answers; usage and
 * history attribute to it), bounded fallback (no A→B→A, no second hop),
 * all-providers-fail (graceful terminal failure), the server-side web-search
 * capability gate (400 pre-stream), and search degradation without a
 * provider key (warning + completed turn, no sources).
 */

const BASE = process.env.API_BASE ?? 'http://localhost:4100/api';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* empty body */
  }
  return { status: response.status, json };
}

async function send(token, conversationId, body) {
  const response = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  // Pre-stream JSON errors arrive as a JSON body, not an event stream.
  if (text.trimStart().startsWith('{')) {
    return { status: response.status, json: JSON.parse(text), events: [] };
  }
  const events = [];
  for (const block of text.split('\n\n').filter(Boolean)) {
    const event = block.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
    const data = block.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
    if (event && data) events.push({ event, data: JSON.parse(data) });
  }
  return { status: response.status, events, finalEvent: events.at(-1)?.event };
}

async function main() {
  const unique = Date.now();

  const adminLogin = await api('POST', '/auth/login', {
    body: { email: 'admin@example.com', password: 'admin1234' },
  });
  check('seeded admin can login', adminLogin.status === 200 && !!adminLogin.json?.accessToken);
  const adminToken = adminLogin.json.accessToken;

  const register = await api('POST', '/auth/register', {
    body: { email: `fallback-${unique}@example.com`, password: 'password123' },
  });
  check('user can register', register.status === 201 && !!register.json?.accessToken);
  const userToken = register.json.accessToken;

  const conversation = await api('POST', '/conversations', {
    token: userToken,
    body: { title: 'fallback e2e' },
  });
  check('user can create a conversation', conversation.status === 201);
  const conversationId = conversation.json.id;

  // ---- fixtures ----

  const mockModel = await api('POST', '/admin/models', {
    token: adminToken,
    body: {
      name: `Mock Fallback Target ${unique}`,
      provider: 'mock',
      externalModelId: 'mock-target',
    },
  });
  check('mock fallback target created', mockModel.status === 201, JSON.stringify(mockModel.json));
  const mockModelId = mockModel.json?.id;

  // Port 9 (discard) refuses connections fast → normalized 'unavailable',
  // a RETRYABLE kind — the fallback-eligible failure for this suite.
  const deadUrl = 'http://127.0.0.1:9/v1';

  const deadPrimary = await api('POST', '/admin/models', {
    token: adminToken,
    body: {
      name: `Dead Primary ${unique}`,
      provider: 'openai-compatible',
      externalModelId: 'gpt-dead',
      baseUrl: deadUrl,
      apiKey: 'sk-e2e',
      fallbackModelId: mockModelId,
    },
  });
  check(
    'dead primary with a fallback target created',
    deadPrimary.status === 201 && deadPrimary.json?.hasFallback === true,
    JSON.stringify(deadPrimary.json),
  );

  const deadNoFallback = await api('POST', '/admin/models', {
    token: adminToken,
    body: {
      name: `Dead Alone ${unique}`,
      provider: 'openai-compatible',
      externalModelId: 'gpt-dead-2',
      baseUrl: deadUrl,
      apiKey: 'sk-e2e',
    },
  });
  check('dead model WITHOUT fallback created', deadNoFallback.status === 201);

  const deadChain = await api('POST', '/admin/models', {
    token: adminToken,
    body: {
      name: `Dead Chain ${unique}`,
      provider: 'openai-compatible',
      externalModelId: 'gpt-dead-3',
      baseUrl: deadUrl,
      apiKey: 'sk-e2e',
      fallbackModelId: deadNoFallback.json?.id,
    },
  });
  check('dead model whose fallback is also dead created', deadChain.status === 201);

  const searcher = await api('POST', '/admin/models', {
    token: adminToken,
    body: {
      name: `Searcher ${unique}`,
      provider: 'mock',
      externalModelId: 'mock-search',
      capabilities: ['web-search'],
    },
  });
  check('search-capable mock model created', searcher.status === 201);
  const searcherId = searcher.json?.id;

  // ---- 1. execution-phase narration on a plain turn ----

  const plain = await send(userToken, conversationId, {
    content: 'سلام، فازها را نشان بده',
    modelId: mockModelId,
    clientMessageId: `plain-${unique}`,
  });
  const statusSequence = plain.events
    .filter((e) => e.event === 'status')
    .map((e) => e.data.status);
  check(
    'plain turn narrates thinking → generating in order',
    JSON.stringify(statusSequence) === JSON.stringify(['thinking', 'generating']),
    JSON.stringify(statusSequence),
  );
  const eventOrder = plain.events.map((e) => e.event);
  const firstDelta = eventOrder.indexOf('delta');
  check(
    'both status events precede the first delta',
    eventOrder.indexOf('status') !== -1 &&
      firstDelta !== -1 &&
      eventOrder.lastIndexOf('status') < firstDelta,
    JSON.stringify(eventOrder),
  );
  check('plain turn completes', plain.finalEvent === 'done');
  check('no fallback detail on a healthy turn', !plain.events.some((e) => e.event === 'status' && e.data.detail === 'fallback'));

  // ---- 2. single-hop fallback on a retryable pre-delta failure ----

  const fallbackTurn = await send(userToken, conversationId, {
    content: 'این نوبت باید جایگزین شود',
    modelId: deadPrimary.json.id,
    clientMessageId: `fallback-${unique}`,
  });
  const fallbackOrder = fallbackTurn.events.map((e) => e.event);
  check('fallback turn still completes', fallbackTurn.finalEvent === 'done');
  const fallbackStatus = fallbackTurn.events.find(
    (e) => e.event === 'status' && e.data.detail === 'fallback',
  );
  check('fallback switch announced via status detail=fallback', Boolean(fallbackStatus));
  check(
    'exactly ONE fallback hop (no loop)',
    fallbackTurn.events.filter((e) => e.event === 'status' && e.data.detail === 'fallback').length === 1,
  );
  check(
    'status sequence: thinking before the switch, generating after',
    JSON.stringify(statusSeq(fallbackTurn)) === JSON.stringify(['thinking', 'generating', 'generating']),
    JSON.stringify(statusSeq(fallbackTurn)),
  );
  const fallbackDone = fallbackTurn.events.at(-1)?.data?.assistantMessage;
  check(
    'terminal row is attributed to the FALLBACK model',
    fallbackDone?.modelId === mockModelId,
    `modelId=${fallbackDone?.modelId}`,
  );
  const deltas = fallbackTurn.events.filter((e) => e.event === 'delta').map((e) => e.data.text);
  check(
    'deltas concatenate exactly to the persisted content (no duplicated text)',
    fallbackDone?.content === deltas.join('') && deltas.length > 0,
  );

  // ---- 3. no fallback configured → graceful final failure ----

  const aloneTurn = await send(userToken, conversationId, {
    content: 'این نوبت شکست می‌خورد',
    modelId: deadNoFallback.json.id,
    clientMessageId: `alone-${unique}`,
  });
  check('all-providers-fail ends with a failed terminal event', aloneTurn.finalEvent === 'failed');
  check(
    'failed terminal keeps a safe user-facing message',
    /موقتاً در دسترس نیست/.test(aloneTurn.events.at(-1)?.data?.message ?? ''),
  );
  check(
    'no fallback status on a turn without a fallback',
    !aloneTurn.events.some((e) => e.event === 'status' && e.data.detail === 'fallback'),
  );
  check(
    'failed row has no fabricated content',
    (aloneTurn.events.at(-1)?.data?.assistantMessage?.content ?? 'x') === '',
  );

  // ---- 4. bounded fallback: the fallback also fails → no second hop ----

  const chainTurn = await send(userToken, conversationId, {
    content: 'زنجیره جایگزین باید محدود بماند',
    modelId: deadChain.json.id,
    clientMessageId: `chain-${unique}`,
  });
  check('dead chain ends with a failed terminal event', chainTurn.finalEvent === 'failed');
  const chainHops = chainTurn.events.filter(
    (e) => e.event === 'status' && e.data.detail === 'fallback',
  ).length;
  check('the chain performed exactly one hop (bounded, no A→B→C)', chainHops === 1, `hops=${chainHops}`);

  // ---- 5. server-side capability gate (400 pre-stream, never SSE) ----

  const forbidden = await send(userToken, conversationId, {
    content: 'جستجو بدون پشتیبانی مدل',
    modelId: mockModelId, // no 'web-search' capability
    webSearch: true,
    clientMessageId: `cap-${unique}`,
  });
  check(
    'webSearch on an incapable model → 400 JSON pre-stream',
    forbidden.status === 400 && forbidden.json?.message?.includes('پشتیبانی نمی‌کند'),
    JSON.stringify(forbidden.json ?? forbidden.status),
  );
  check('the 400 arrived before any SSE event', Array.isArray(forbidden.events) && forbidden.events.length === 0);

  // ---- 6. search degrades without a provider key (turn still completes) ----

  const degraded = await send(userToken, conversationId, {
    content: 'وضعیت آب و هوای امروز تهران',
    modelId: searcherId,
    webSearch: true,
    clientMessageId: `degrade-${unique}`,
  });
  check('degraded search turn completes', degraded.finalEvent === 'done');
  check(
    'search_started event emitted',
    degraded.events.some((e) => e.event === 'search_started'),
  );
  const completed = degraded.events.find((e) => e.event === 'search_completed');
  check(
    'search_completed carries the safe degrade warning',
    Boolean(completed?.data?.warning),
    JSON.stringify(completed?.data ?? null),
  );
  const degradedDone = degraded.events.at(-1)?.data?.assistantMessage;
  check(
    'no sources persisted when search degraded',
    degradedDone?.sources === null || degradedDone?.sources === undefined,
  );

  // ---- 7. admin fallback rules ----

  const selfRef = await api('PATCH', `/admin/models/${mockModelId}`, {
    token: adminToken,
    body: { fallbackModelId: mockModelId },
  });
  check('self-reference fallback rejected (400)', selfRef.status === 400, `status=${selfRef.status}`);

  const premium = await api('POST', '/admin/models', {
    token: adminToken,
    body: {
      name: `Premium Dead ${unique}`,
      provider: 'openai-compatible',
      externalModelId: 'gpt-premium',
      baseUrl: deadUrl,
      apiKey: 'sk-e2e',
      isFree: false,
    },
  });
  const premiumForFree = await api('PATCH', `/admin/models/${mockModelId}`, {
    token: adminToken,
    body: { fallbackModelId: premium.json?.id },
  });
  check(
    'premium fallback for a free model rejected (400)',
    premiumForFree.status === 400,
    `status=${premiumForFree.status}`,
  );

  const missing = await api('PATCH', `/admin/models/${mockModelId}`, {
    token: adminToken,
    body: { fallbackModelId: '00000000-0000-4000-8000-000000000000' },
  });
  check('unknown fallback id rejected (400)', missing.status === 400, `status=${missing.status}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

/** Status payload sequence of a send() result. */
function statusSeq(result) {
  return result.events.filter((e) => e.event === 'status').map((e) => e.data.status);
}

main().catch((error) => {
  console.error('E2E crashed:', error);
  process.exit(1);
});
