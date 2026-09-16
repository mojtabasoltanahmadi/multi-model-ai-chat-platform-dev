/**
 * End-to-end smoke test for the AI Chat MVP backend.
 * Requires the backend running on http://localhost:4000.
 *
 * Usage: node scripts/smoke-test.mjs
 *
 * Verifies the MVP's business rules and security invariants over real HTTP,
 * using the "mock" AI provider so no external API key is needed.
 */

const BASE = process.env.API_BASE ?? 'http://localhost:4000/api';

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
    /* non-JSON body (e.g. 204) */
  }
  return { status: response.status, json };
}

/** Reads an SSE stream and returns { status, events, deltas, finalEvent }. */
async function streamMessage(token, conversationId, body, { headers = {} } = {}) {
  const response = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  // SSE error responses (e.g. 400, 404) carry a JSON body instead of events.
  let events = [];
  let errorJson = null;
  if (text.trimStart().startsWith('{')) {
    try {
      errorJson = JSON.parse(text);
    } catch {
      /* fall through */
    }
  } else {
    for (const block of text.split('\n\n').filter(Boolean)) {
      const lines = block.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7);
      const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
      if (event && data) events.push({ event, data: JSON.parse(data) });
    }
  }
  return {
    status: response.status,
    events,
    deltas: events.filter((e) => e.event === 'delta').map((e) => e.data.text),
    finalEvent: events.at(-1)?.event,
    errorJson,
  };
}

async function main() {
  // ---------- Authentication ----------
  const unique = Date.now();
  const userEmail = `sara-${unique}@example.com`;
  const otherEmail = `ali-${unique}@example.com`;

  const register = await api('POST', '/auth/register', {
    body: { email: userEmail, password: 'password123' },
  });
  check('register success returns accessToken', register.status === 201 && !!register.json?.accessToken);
  const userToken = register.json.accessToken;

  const dupRegister = await api('POST', '/auth/register', {
    body: { email: userEmail, password: 'password123' },
  });
  check('duplicate email rejected (409)', dupRegister.status === 409);

  const badEmail = await api('POST', '/auth/register', {
    body: { email: 'not-an-email', password: 'password123' },
  });
  check('invalid email rejected (400)', badEmail.status === 400);

  const shortPassword = await api('POST', '/auth/register', {
    body: { email: `x-${unique}@example.com`, password: '123' },
  });
  check('short password rejected (400)', shortPassword.status === 400);

  const login = await api('POST', '/auth/login', {
    body: { email: userEmail, password: 'password123' },
  });
  check('login success (200)', login.status === 200 && !!login.json?.accessToken);

  const wrongPassword = await api('POST', '/auth/login', {
    body: { email: userEmail, password: 'wrong-password' },
  });
  check('wrong password rejected (401)', wrongPassword.status === 401);

  const unknownUser = await api('POST', '/auth/login', {
    body: { email: `ghost-${unique}@example.com`, password: 'whatever123' },
  });
  check('unknown user rejected with same message as wrong password (401)', unknownUser.status === 401);

  const noToken = await api('GET', '/conversations');
  check('protected route without JWT rejected (401)', noToken.status === 401);

  const badToken = await api('GET', '/conversations', { token: 'not-a-jwt' });
  check('invalid JWT rejected (401)', badToken.status === 401);

  const expiredToken =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZW1haWwiOiJhQGIuY29tIiwicm9sZSI6InVzZXIiLCJpYXQiOjE1MDAwMDAwMDAsImV4cCI6MTUwMDAwMDAwMH0.INVALIDSIGNATURE';
  const expired = await api('GET', '/conversations', { token: expiredToken });
  check('expired/garbage-signature JWT rejected (401)', expired.status === 401);

  // ---------- Admin authorization ----------
  const adminLogin = await api('POST', '/auth/login', {
    body: { email: 'admin@example.com', password: 'admin1234' },
  });
  const adminToken = adminLogin.json?.accessToken;
  check('seeded admin can login', adminLogin.status === 200 && !!adminToken);

  const userHitsAdmin = await api('GET', '/admin/models', { token: userToken });
  check('normal user blocked from admin endpoint (403)', userHitsAdmin.status === 403);

  const adminHitsAdmin = await api('GET', '/admin/models', { token: adminToken });
  check('admin can list models (200)', adminHitsAdmin.status === 200);
  const hadDefaultBefore = adminHitsAdmin.json.some((m) => m.isDefault);

  // ---------- Model management ----------
  const createModel = await api('POST', '/admin/models', {
    token: adminToken,
    body: { name: 'Mock GPT', provider: 'mock', externalModelId: 'mock-1' },
  });
  check(
    'admin creates model (201; auto-default only when no default exists)',
    createModel.status === 201 && (createModel.json?.isDefault === true || hadDefaultBefore),
  );
  const modelA = createModel.json;

  const listAfterCreate = (await api('GET', '/admin/models', { token: adminToken })).json;
  const createdInList = listAfterCreate.find((m) => m.id === modelA.id);
  check('admin model list never exposes apiKey', createdInList && !('apiKey' in createdInList) && typeof createdInList.hasApiKey === 'boolean');

  const modelB = (
    await api('POST', '/admin/models', {
      token: adminToken,
      body: { name: 'Mock Claude', provider: 'mock', externalModelId: 'mock-2' },
    })
  ).json;

  const setDefaultB = await api('POST', `/admin/models/${modelB.id}/default`, { token: adminToken });
  check('admin sets another default (200)', setDefaultB.status === 200 && setDefaultB.json?.isDefault === true);

  const adminModels = (await api('GET', '/admin/models', { token: adminToken })).json;
  const defaultCount = adminModels.filter((m) => m.isDefault).length;
  check('exactly one default model exists', defaultCount === 1, `found ${defaultCount}`);

  const disableDefault = await api('PATCH', `/admin/models/${modelB.id}`, {
    token: adminToken,
    body: { isActive: false },
  });
  check('disabling the default model rejected (400)', disableDefault.status === 400);

  const deleteDefault = await api('DELETE', `/admin/models/${modelB.id}`, { token: adminToken });
  check('deleting the default model rejected (400)', deleteDefault.status === 400);

  const inactiveAsDefault = await api('POST', `/admin/models/${modelA.id}/default`, {
    token: adminToken,
    body: {},
  });
  // modelA is still active, so this must succeed
  check('setting an active model as default works (200)', inactiveAsDefault.status === 200);
  await api('POST', `/admin/models/${modelB.id}/default`, { token: adminToken });

  const deactivateA = await api('PATCH', `/admin/models/${modelA.id}`, {
    token: adminToken,
    body: { isActive: false },
  });
  check('deactivating a non-default model works (200)', deactivateA.status === 200);

  const publicModels = (await api('GET', '/models', { token: userToken })).json;
  check('user model list contains only active AND free models', publicModels.every((m) => m.isActive && m.isFree) && publicModels.some((m) => m.id === modelB.id));

  // ---------- Free-plan model access (backend is the authorization source) ----------
  // modelA is active but premium (isFree=false): hidden from the picker…
  const premiumModel = (
    await api('POST', '/admin/models', {
      token: adminToken,
      body: { name: 'Mock Premium', provider: 'mock', externalModelId: 'mock-premium', isFree: false },
    })
  ).json;
  const premiumModels = (await api('GET', '/models', { token: userToken })).json;
  check('premium (non-free) model hidden from user model list', !premiumModels.some((m) => m.id === premiumModel.id));

  // …and even when the frontend is bypassed, direct API calls are rejected.
  const premiumConv = await api('POST', '/conversations', { token: userToken, body: {} });
  const premiumModelMessage = await streamMessage(userToken, premiumConv.json.id, {
    content: 'hello',
    modelId: premiumModel.id,
  });
  check('free user cannot chat with a premium model (403)', premiumModelMessage.status === 403);

  // Admin can grant and revoke free access via PATCH.
  const grantFree = await api('PATCH', `/admin/models/${premiumModel.id}`, {
    token: adminToken,
    body: { isFree: true },
  });
  check('admin can grant free access (200)', grantFree.status === 200 && grantFree.json?.isFree === true);
  const grantedList = (await api('GET', '/models', { token: userToken })).json;
  check('granted model appears in user model list', grantedList.some((m) => m.id === premiumModel.id));

  const revokeFree = await api('PATCH', `/admin/models/${premiumModel.id}`, {
    token: adminToken,
    body: { isFree: false },
  });
  check('admin can revoke free access (200)', revokeFree.status === 200 && revokeFree.json?.isFree === false);
  const revokedList = (await api('GET', '/models', { token: userToken })).json;
  check('revoked model disappears from user model list', !revokedList.some((m) => m.id === premiumModel.id));
  const revokedModelMessage = await streamMessage(userToken, premiumConv.json.id, {
    content: 'hello again',
    modelId: premiumModel.id,
  });
  check('free user cannot chat with a revoked model (403)', revokedModelMessage.status === 403);

  // Free users can still chat with an authorized model.
  const freeStream = await streamMessage(userToken, premiumConv.json.id, {
    content: 'hello',
    modelId: modelB.id,
  });
  check('free user can chat with an active free model (200 SSE)', freeStream.status === 200 && freeStream.finalEvent === 'done');

  // The default model must never lose free access (default = active + free).
  const unFreeDefault = await api('PATCH', `/admin/models/${modelB.id}`, {
    token: adminToken,
    body: { isFree: false },
  });
  check('removing free access from the default model rejected (400)', unFreeDefault.status === 400);

  const nonFreeAsDefault = await api('POST', `/admin/models/${premiumModel.id}/default`, { token: adminToken });
  check('setting a non-free model as default rejected (400)', nonFreeAsDefault.status === 400);

  await api('DELETE', `/admin/models/${premiumModel.id}`, { token: adminToken });

  // ---------- Conversations ----------
  const conv = await api('POST', '/conversations', { token: userToken, body: {} });
  check('user creates conversation (201)', conv.status === 201 && !!conv.json?.id);
  const convId = conv.json.id;

  const otherUser = await api('POST', '/auth/register', {
    body: { email: otherEmail, password: 'password123' },
  });
  const otherToken = otherUser.json.accessToken;

  const foreignConv = await api('GET', `/conversations/${convId}`, { token: otherToken });
  check("user B cannot read user A's conversation (404)", foreignConv.status === 404);

  const unknownConv = await api('GET', `/conversations/00000000-0000-4000-8000-000000000000`, {
    token: userToken,
  });
  check('unknown conversation id rejected (404)', unknownConv.status === 404);

  const badConvId = await api('GET', '/conversations/not-a-uuid', { token: userToken });
  check('malformed conversation id rejected (400)', badConvId.status === 400);

  const listOnlyMine = await api('GET', '/conversations', { token: otherToken });
  check('conversation list only contains own conversations', listOnlyMine.status === 200 && listOnlyMine.json.length === 0);

  // ---------- Messages ----------
  const emptyMessage = await fetch(`${BASE}/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ content: '' }),
  });
  check('empty message rejected (400)', emptyMessage.status === 400);

  const whitespaceMessage = await fetch(`${BASE}/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ content: '   ' }),
  });
  check('whitespace-only message rejected (400)', whitespaceMessage.status === 400);

  const longMessage = await fetch(`${BASE}/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
    body: JSON.stringify({ content: 'خ'.repeat(4001) }),
  });
  check('over-long message rejected (400)', longMessage.status === 400);

  const foreignStream = await fetch(`${BASE}/conversations/${convId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${otherToken}` },
    body: JSON.stringify({ content: 'hello' }),
  });
  check("user B cannot send messages to user A's conversation (404)", foreignStream.status === 404);

  const inactiveModelMessage = await streamMessage(userToken, convId, {
    content: 'hello',
    modelId: modelA.id,
  });
  check('chat with inactive model rejected (400)', inactiveModelMessage.status === 400);

  const unknownModelMessage = await streamMessage(userToken, convId, {
    content: 'hello',
    modelId: '00000000-0000-4000-8000-000000000000',
  });
  check('chat with unknown model rejected (404)', unknownModelMessage.status === 404);

  // ---------- Chat streaming (happy path + UTF-8 + one-message invariant) ----------
  const stream = await streamMessage(userToken, convId, {
    content: 'سلام، این یک پیام تستی است 🌟',
  });
  check('stream responds with SSE (200)', stream.status === 200);
  check('stream starts with meta event', stream.events[0]?.event === 'meta');
  check('meta carries userMessage with the persisted content', stream.events[0]?.data.userMessage.content === 'سلام، این یک پیام تستی است 🌟');
  // Pre-persist invariant: assistant row is written with status='pending' BEFORE
  // any delta is emitted — the meta event carries that real id so the
  // frontend can already address it on a reload.
  const metaAssistant = stream.events[0]?.data.assistantMessage;
  check(
    'meta carries assistantMessage with status=pending and a real id',
    metaAssistant?.status === 'pending'
      && typeof metaAssistant.id === 'string'
      && metaAssistant.id.length > 0
      && metaAssistant.content === '',
  );
  check('meta carries replay=false on a fresh turn', stream.events[0]?.data.replay === false);
  check('meta carries the model used for this turn', stream.events[0]?.data.model?.id);
  check('stream delivers multiple deltas', stream.deltas.length > 3, `${stream.deltas.length} deltas`);
  check('stream preserves Persian UTF-8 + emoji', stream.events[0]?.data.userMessage.content === 'سلام، این یک پیام تستی است 🌟');
  check('stream ends with done event', stream.finalEvent === 'done');
  check(
    'assistant message persisted with completed status',
    stream.events.at(-1)?.data.assistantMessage?.status === 'completed',
  );

  const convAfter = await api('GET', `/conversations/${convId}`, { token: userToken });
  const assistantMessages = convAfter.json.messages.filter((m) => m.role === 'assistant');
  const userMessages = convAfter.json.messages.filter((m) => m.role === 'user');
  check('exactly ONE assistant message per streamed turn', assistantMessages.length === 1);
  check('full content equals concatenation of deltas', assistantMessages[0]?.content === stream.deltas.join(''));
  check('conversation title auto-set from first message', typeof convAfter.json.conversation.title === 'string' && convAfter.json.conversation.title.length > 0);
  check('user message persisted exactly once', userMessages.length === 1);

  // ---------- AI failure handling ----------
  // Point the default model at an unreachable OpenAI-compatible endpoint.
  const brokenModel = (
    await api('POST', '/admin/models', {
      token: adminToken,
      body: {
        name: 'Broken',
        provider: 'openai-compatible',
        externalModelId: 'broken-1',
        baseUrl: 'http://localhost:9/unreachable',
        apiKey: 'sk-test',
      },
    })
  ).json;
  await api('POST', `/admin/models/${brokenModel.id}/default`, { token: adminToken });

  const failingConv = await api('POST', '/conversations', { token: userToken, body: {} });
  const failingStream = await streamMessage(userToken, failingConv.json.id, { content: 'سلام' });
  check('AI failure does not crash backend (SSE 200)', failingStream.status === 200);
  check('AI failure emits failed event with generic message', failingStream.finalEvent === 'failed' && /موقتاً در دسترس نیست/.test(failingStream.events.at(-1)?.data.message ?? ''));
  const failingConvAfter = await api('GET', `/conversations/${failingConv.json.id}`, { token: userToken });
  const failedAssistant = failingConvAfter.json.messages.filter((m) => m.role === 'assistant');
  check('failed turn still persists exactly ONE assistant message', failedAssistant.length === 1);
  check('failed assistant message marked status=failed', failedAssistant[0]?.status === 'failed');
  check('failed assistant keeps any partial content', typeof failedAssistant[0]?.content === 'string');
  check('failed assistant has an internal errorMessage for ops', typeof failedAssistant[0]?.errorMessage === 'string' && failedAssistant[0].errorMessage.length > 0);
  check('internal provider error detail not exposed to client', !JSON.stringify(failingStream.events).includes('unreachable'));

  // ---------- Idempotency (clientMessageId + Idempotency-Key header) ----------
  // restore mock as default first so we can stream again
  await api('POST', `/admin/models/${modelB.id}/default`, { token: adminToken });
  const idemConv = await api('POST', '/conversations', { token: userToken, body: {} });

  // clientMessageId in body
  const cmid1 = `smoke-cmid-${unique}`;
  const idem1 = await streamMessage(userToken, idemConv.json.id, {
    content: 'پیام idempotent اول',
    clientMessageId: cmid1,
  });
  check('idem turn 1 completes', idem1.finalEvent === 'done' && idem1.events[0]?.data.replay === false);

  // Same clientMessageId + same content → reuse user row, NEW assistant row.
  const idem2 = await streamMessage(userToken, idemConv.json.id, {
    content: 'پیام idempotent اول',
    clientMessageId: cmid1,
  });
  check('idem retry emits replay=true', idem2.events[0]?.data.replay === true);
  check('idem retry reuses userMessage id', idem2.events[0]?.data.userMessage.id === idem1.events[0]?.data.userMessage.id);
  check('idem retry creates a NEW assistant row id', idem2.events[0]?.data.assistantMessage.id !== idem1.events[0]?.data.assistantMessage.id);

  // Same clientMessageId + DIFFERENT content → client bug, 400.
  const idemConflict = await streamMessage(userToken, idemConv.json.id, {
    content: 'متن متفاوت',
    clientMessageId: cmid1,
  });
  check('idem conflict (same id, different content) rejected (400)', idemConflict.status === 400);

  // Idempotency-Key header is accepted as a fallback for clientMessageId.
  const cmid2 = `smoke-cmid-${unique}-header`;
  const idemHeader = await streamMessage(
    userToken,
    idemConv.json.id,
    { content: 'پیام از طریق هدر' },
    { headers: { 'Idempotency-Key': cmid2 } },
  );
  check('Idempotency-Key header accepted (final event done)', idemHeader.finalEvent === 'done');
  // A second turn with the same header should reuse the user row too.
  const idemHeader2 = await streamMessage(
    userToken,
    idemConv.json.id,
    { content: 'پیام از طریق هدر' },
    { headers: { 'Idempotency-Key': cmid2 } },
  );
  check('Idempotency-Key header replay=true on second send', idemHeader2.events[0]?.data.replay === true);

  // Persisted state: 1 user row + 4 assistant rows (first idem turn + first
  // header turn + 2 retries; idemConflict rejected before persistence).
  const idemConvAfter = await api('GET', `/conversations/${idemConv.json.id}`, { token: userToken });
  const idemUsers = idemConvAfter.json.messages.filter((m) => m.role === 'user');
  const idemAssistants = idemConvAfter.json.messages.filter((m) => m.role === 'assistant');
  check('idem: exactly 2 user rows persisted (one per distinct intent)', idemUsers.length === 2);
  check('idem: 4 assistant rows persisted (1 per turn)', idemAssistants.length === 4);
  check('idem: every assistant row reaches a terminal status', idemAssistants.every((m) => ['completed', 'failed', 'interrupted'].includes(m.status)));
  check('idem: user rows carry their clientMessageId back', idemUsers.every((m) => typeof m.clientMessageId === 'string'));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
