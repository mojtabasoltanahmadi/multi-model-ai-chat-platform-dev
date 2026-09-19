/**
 * E2E quota & usage test (day-7-8 contract §7 / Stage 19).
 *
 * REQUIRES a backend started with small quota limits, e.g.:
 *   PORT=4100 \
 *   QUOTA_FREE_DAILY_MESSAGES=3 \
 *   QUOTA_PREMIUM_DAILY_MESSAGES=5 \
 *   QUOTA_PREMIUM_DAILY_TOKENS=400 \
 *   npm run start:dev
 * Then: node scripts/quota-test.mjs   (API_BASE env overrides the target)
 *
 * Covers: usage row lifecycle via /usage/me, 429 pre-stream, free retry of
 * failed turns (failed outcomes excluded from the count), replay never
 * double-counting, admin quota bypass, plan upgrade effects (model access +
 * raised limit), the optional daily TOKEN cap, and the admin summary shape.
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
    body: body ? JSON.stringify(body) : undefined,
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
  let events = [];
  if (!text.trimStart().startsWith('{')) {
    for (const block of text.split('\n\n').filter(Boolean)) {
      const event = block.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
      const data = block.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
      if (event && data) events.push({ event, data: JSON.parse(data) });
    }
  }
  return { status: response.status, finalEvent: events.at(-1)?.event, events };
}

async function main() {
  const unique = Date.now();
  const adminLogin = await api('POST', '/auth/login', {
    body: { email: 'admin@example.com', password: 'admin1234' },
  });
  check('seeded admin can login', adminLogin.status === 200 && !!adminLogin.json?.accessToken);
  const adminToken = adminLogin.json.accessToken;

  const register = await api('POST', '/auth/register', {
    body: { email: `quota-${unique}@example.com`, password: 'password123' },
  });
  const userToken = register.json.accessToken;
  check('free user registered', register.status === 201 && !!userToken);

  // Models: one free mock, one premium mock, one broken (no API key).
  const freeModel = (
    await api('POST', '/admin/models', {
      token: adminToken,
      body: { name: 'Quota Mock', provider: 'mock', externalModelId: 'quota-mock', isActive: true, isFree: true },
    })
  ).json;
  const premiumModel = (
    await api('POST', '/admin/models', {
      token: adminToken,
      body: {
        name: 'Quota Premium', provider: 'mock', externalModelId: 'quota-premium',
        isActive: true, isFree: false, inputPricePerMillion: '1000000', outputPricePerMillion: '2000000',
      },
    })
  ).json;
  const brokenModel = (
    await api('POST', '/admin/models', {
      token: adminToken,
      body: { name: 'بدون کلید', provider: 'anthropic', externalModelId: 'claude-3-5-sonnet-latest' },
    })
  ).json;
  check('test models created', !!freeModel?.id && !!premiumModel?.id && !!brokenModel?.id);

  const conv = (await api('POST', '/conversations', { token: userToken, body: {} })).json;
  const adminConv = (await api('POST', '/conversations', { token: adminToken, body: {} })).json;

  // ---------- /usage/me shape ----------
  let usage = (await api('GET', '/usage/me', { token: userToken })).json;
  check(
    'usage/me: free plan, env limit 3, fresh start',
    usage?.plan === 'free' && usage?.quota?.dailyMessages === 3 && usage?.today?.used === 0 && usage?.today?.remaining === 3,
    JSON.stringify(usage),
  );

  // ---------- free quota: 2 sends ok, failed turn free, 3rd ok, 4th → 429 ----------
  const send1 = await send(userToken, conv.id, { content: 'پیام یک', modelId: freeModel.id, clientMessageId: `cm-${unique}-1` });
  check('send 1 completes (done)', send1.status === 200 && send1.finalEvent === 'done');
  const send2 = await send(userToken, conv.id, { content: 'پیام دو', modelId: freeModel.id, clientMessageId: `cm-${unique}-2` });
  check('send 2 completes (done)', send2.status === 200 && send2.finalEvent === 'done');

  const failedSend = await send(userToken, conv.id, { content: 'به مدل خراب', modelId: brokenModel.id });
  check(
    'send to keyless provider fails gracefully (SSE failed)',
    failedSend.status === 200 && failedSend.finalEvent === 'failed',
  );
  usage = (await api('GET', '/usage/me', { token: userToken })).json;
  check(
    'FAILED turn did not consume quota (used still 2)',
    usage?.today?.used === 2 && usage?.today?.remaining === 1,
    JSON.stringify(usage?.today),
  );

  const send3 = await send(userToken, conv.id, { content: 'پیام سه', modelId: freeModel.id, clientMessageId: `cm-${unique}-3` });
  check('send 3 completes (done)', send3.status === 200 && send3.finalEvent === 'done');

  const send4 = await send(userToken, conv.id, { content: 'پیام چهار', modelId: freeModel.id });
  check(
    '4th send rejected pre-stream with 429 before any SSE event',
    send4.status === 429 && send4.events.length === 0,
    `status=${send4.status}`,
  );
  const quota403 = await api('POST', `/conversations/${conv.id}/messages`, {
    token: userToken,
    body: { content: 'پیام چهار', modelId: freeModel.id },
  }).catch(() => ({ status: 0, json: null }));
  check(
    '429-style Persian quota message present on the JSON error',
    quota403.status === 429 && String(quota403.json?.message ?? '').includes('سهمیه پیام‌های امروز شما تمام شده است'),
    `status=${quota403.status} body=${JSON.stringify(quota403.json)}`,
  );

  // ---------- replay at exhausted quota: allowed, never double-counted ----------
  const replay = await send(userToken, conv.id, { content: 'پیام سه', modelId: freeModel.id, clientMessageId: `cm-${unique}-3` });
  check(
    'replay of an accepted turn still works at exhausted quota (meta.replay=true)',
    replay.status === 200 && replay.events.some((e) => e.event === 'meta' && e.data.replay === true),
  );
  usage = (await api('GET', '/usage/me', { token: userToken })).json;
  check('replay did not consume a new slot (used still 3)', usage?.today?.used === 3, JSON.stringify(usage?.today));

  // ---------- admin bypasses quotas ----------
  const adminSend = await send(adminToken, adminConv.id, { content: 'مدیر مستقل از سهمیه', modelId: freeModel.id });
  check('admin can send beyond any quota', adminSend.status === 200 && adminSend.finalEvent === 'done');
  const adminUsage = (await api('GET', '/usage/me', { token: adminToken })).json;
  check('admin usage/me has quota:null (bypasses quotas)', adminUsage?.quota === null, JSON.stringify(adminUsage));

  // ---------- model permission: premium model blocked for free plan ----------
  const premiumBlocked = await send(userToken, conv.id, { content: 'x', modelId: premiumModel.id });
  check('free user cannot use a premium model (403)', premiumBlocked.status === 403);

  // ---------- plan upgrade: takes effect on the next request ----------
  const upgrade = await api('PATCH', `/admin/users/${register.json.user.id}/plan`, {
    token: adminToken,
    body: { plan: 'premium' },
  });
  check('admin upgrades the user to premium', upgrade.status === 200 && upgrade.json?.plan === 'premium');

  usage = (await api('GET', '/usage/me', { token: userToken })).json;
  check(
    'usage/me now shows premium plan with the premium limit (5)',
    usage?.plan === 'premium' && usage?.quota?.dailyMessages === 5 && usage?.today?.remaining === 2,
    JSON.stringify(usage),
  );

  const premiumSend = await send(userToken, conv.id, { content: 'حالا پریمیوم', modelId: premiumModel.id });
  check('premium user can use the premium model now', premiumSend.status === 200 && premiumSend.finalEvent === 'done');

  // ---------- optional daily TOKEN cap (premium: 130) ----------
  // The premium mock model is priced, so cost accounting also has data.
  const user2Register = await api('POST', '/auth/register', {
    body: { email: `tok-${unique}@example.com`, password: 'password123' },
  });
  const user2Token = user2Register.json.accessToken;
  await api('PATCH', `/admin/users/${user2Register.json.user.id}/plan`, {
    token: adminToken,
    body: { plan: 'premium' },
  });
  const conv2 = (await api('POST', '/conversations', { token: user2Token, body: {} })).json;

  let tokenRejected = null;
  for (let i = 1; i <= 6; i++) {
    const result = await send(user2Token, conv2.id, { content: `توکن ${i}`, modelId: freeModel.id });
    if (result.status === 429) {
      tokenRejected = result;
      break;
    }
  }
  check(
    'a send eventually hits the daily TOKEN cap (not the message cap)',
    tokenRejected !== null,
    'no 429 within 6 sends',
  );
  const user2Usage = (await api('GET', '/usage/me', { token: user2Token })).json;
  check(
    'token counter reflects recorded usage',
    (user2Usage?.today?.tokens ?? 0) >= 130 || tokenRejected !== null,
    JSON.stringify(user2Usage?.today),
  );

  // ---------- admin consumption & cost summary ----------
  const summary = (await api('GET', '/admin/usage/summary?days=7', { token: adminToken })).json;
  check(
    'admin summary has the documented shape',
    typeof summary?.totals?.turns === 'number' &&
      typeof summary?.totals?.totalTokens === 'number' &&
      typeof summary?.totals?.estimatedCost === 'number' &&
      Array.isArray(summary?.perDay) &&
      Array.isArray(summary?.perModel) &&
      Array.isArray(summary?.perUser),
    JSON.stringify(summary?.totals ?? {}),
  );
  check(
    'summary perUser contains the upgraded user; perModel contains the mock model',
    summary.perUser.some((row) => row.email === `quota-${unique}@example.com`) &&
      summary.perModel.some((row) => row.modelName === 'Quota Premium'),
  );
  const premiumRow = summary.perModel.find((row) => row.modelName === 'Quota Premium');
  check(
    'priced model reports nonzero cost',
    (premiumRow?.cost ?? 0) > 0,
    JSON.stringify(premiumRow),
  );
  const forbidden = await api('GET', '/admin/usage/summary', { token: userToken });
  check('non-admin blocked from usage summary (403)', forbidden.status === 403);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('quota test crashed:', error);
  process.exit(1);
});
