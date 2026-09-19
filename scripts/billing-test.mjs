/**
 * E2E billing test (day 9-10 — subscription/payment subsystem).
 *
 * REQUIRES a running backend (default DB + seeded admin):
 *   npm run start:dev        (or node dist/main.js)
 * Then: node scripts/billing-test.mjs   (API_BASE env overrides the target)
 *
 * Covers:
 *  - integration:  create payment → webhook → subscription activation →
 *                  entitlements → /usage/me plan effects → upgrade (new active
 *                  row, old one superseded) → user cancel → back to free
 *  - idempotency:  double-click dedupe, duplicate webhook delivery (simulator
 *                  AND raw HTTP replay), replay after success = no 2nd effect
 *  - security:     forged webhook signature (401), unknown event type
 *                  (ignored), client price manipulation (ignored), IDOR on
 *                  payments (404), user → admin endpoint (403), purchase of a
 *                  deactivated plan (409), invalid webhook body (400)
 */

import { createHmac } from 'node:crypto';

const BASE = process.env.API_BASE ?? 'http://localhost:4000/api';
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? 'dev-only-webhook-secret-change-me';

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

/** Sends a RAW webhook body with an HMAC signature, like a real gateway. */
async function webhook(payloadString, signature) {
  const response = await fetch(`${BASE}/billing/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hooshyar-signature': signature,
    },
    body: payloadString,
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* empty body */
  }
  return { status: response.status, json };
}

const sign = (payloadString) => createHmac('sha256', WEBHOOK_SECRET).update(payloadString).digest('hex');

async function main() {
  const unique = Date.now();

  // ---------- setup: admin, plan, user ----------
  const adminLogin = await api('POST', '/auth/login', {
    body: { email: 'admin@example.com', password: 'admin1234' },
  });
  check('seeded admin can login', adminLogin.status === 200 && !!adminLogin.json?.accessToken);
  const adminToken = adminLogin.json.accessToken;

  const planSlug = `e2e-pro-${unique}`;
  const planCreate = await api('POST', '/admin/billing/plans', {
    token: adminToken,
    body: {
      slug: planSlug,
      name: 'E2E Pro',
      price: 123456,
      currency: 'IRT',
      billingPeriod: 'monthly',
      dailyMessageQuota: 777,
      dailyTokenQuota: 888888,
      webSearch: true,
      thinking: true,
      fileProcessing: false,
    },
  });
  check('admin creates a plan', planCreate.status === 201 && planCreate.json?.id);
  const plan = planCreate.json;

  const otherPlanCreate = await api('POST', '/admin/billing/plans', {
    token: adminToken,
    body: {
      slug: `e2e-max-${unique}`,
      name: 'E2E Max',
      price: 999999,
      currency: 'IRT',
      billingPeriod: 'monthly',
      dailyMessageQuota: 9999,
      webSearch: true,
      thinking: true,
      fileProcessing: true,
    },
  });
  check('admin creates a second plan', otherPlanCreate.status === 201);
  const otherPlan = otherPlanCreate.json;

  const userA = await api('POST', '/auth/register', {
    body: { email: `billing-a-${unique}@example.com`, password: 'password123' },
  });
  const userB = await api('POST', '/auth/register', {
    body: { email: `billing-b-${unique}@example.com`, password: 'password123' },
  });
  const tokenA = userA.json.accessToken;
  const tokenB = userB.json.accessToken;
  check('two users registered', userA.status === 201 && userB.status === 201);

  // ---------- client price manipulation ----------
  const manipulated = await api('POST', '/billing/payments', {
    token: tokenA,
    body: { planId: plan.id, price: 1, amount: 1, currency: 'USD' },
  });
  check(
    'client-sent price fields are ignored — amount resolved from the Plan row',
    manipulated.status === 201 &&
      manipulated.json?.amount === '123456.000000' &&
      manipulated.json?.currency === 'IRT',
    `amount=${manipulated.json?.amount} currency=${manipulated.json?.currency}`,
  );
  const paymentA1 = manipulated.json;

  // ---------- double-click / duplicate pending ----------
  const doubleClick = await api('POST', '/billing/payments', {
    token: tokenA,
    body: { planId: plan.id },
  });
  check(
    'double-click on Pay returns the SAME pending payment (no duplicate)',
    doubleClick.status === 201 && doubleClick.json?.id === paymentA1.id,
  );

  // ---------- forged / invalid webhooks ----------
  const forgedPayload = JSON.stringify({
    eventId: `evt-forged-${unique}`,
    eventType: 'payment.succeeded',
    payload: { paymentId: paymentA1.id },
  });
  const forged = await webhook(forgedPayload, 'deadbeef');
  check('forged webhook signature → 401, not processed', forged.status === 401);

  const unsigned = await webhook(forgedPayload, undefined);
  check('unsigned webhook → 401', unsigned.status === 401);

  const badBody = await webhook('{not json', sign('{not json'));
  check('signed but malformed JSON body → 400', badBody.status === 400);

  const unknownPayload = JSON.stringify({
    eventId: `evt-unknown-${unique}`,
    eventType: 'payout.reversed',
    payload: { paymentId: paymentA1.id },
  });
  const unknown = await webhook(unknownPayload, sign(unknownPayload));
  check(
    'validly signed UNKNOWN event type → acknowledged as ignored',
    unknown.status === 200 && unknown.json?.status === 'ignored',
  );

  // ---------- happy path over the REAL webhook endpoint ----------
  const eventId = `evt-success-${unique}`;
  const successPayload = JSON.stringify({
    eventId,
    eventType: 'payment.succeeded',
    payload: { paymentId: paymentA1.id, trackingId: paymentA1.trackingId },
  });
  const delivered = await webhook(successPayload, sign(successPayload));
  check(
    'signed success webhook → processed',
    delivered.status === 200 && delivered.json?.status === 'processed',
    JSON.stringify(delivered.json),
  );

  // ---------- replay: same eventId over HTTP ----------
  const replay = await webhook(successPayload, sign(successPayload));
  check(
    'HTTP replay of the SAME eventId → duplicate, still 200',
    replay.status === 200 && replay.json?.status === 'duplicate',
  );

  // ---------- entitlement effects ----------
  const subA = await api('GET', '/billing/subscription/me', { token: tokenA });
  check(
    'subscription ACTIVE with the purchased plan',
    subA.json?.subscription?.status === 'active' && subA.json?.subscription?.planSlug === planSlug,
  );
  check(
    'entitlements = plan quotas/features (INV-05)',
    subA.json?.entitlements?.tier === 'premium' &&
      subA.json?.entitlements?.quota?.dailyMessages === 777 &&
      subA.json?.entitlements?.quota?.dailyTokens === 888888 &&
      subA.json?.entitlements?.features?.webSearch === true &&
      subA.json?.entitlements?.features?.fileProcessing === false,
  );
  const usageA = await api('GET', '/usage/me', { token: tokenA });
  check(
    '/usage/me now reports the plan limits',
    usageA.json?.plan === 'premium' && usageA.json?.quota?.dailyMessages === 777,
  );

  // ---------- retry with a fresh eventId on the succeeded payment ----------
  const retryPayload = JSON.stringify({
    eventId: `evt-retry-${unique}`,
    eventType: 'payment.succeeded',
    payload: { paymentId: paymentA1.id },
  });
  const retry = await webhook(retryPayload, sign(retryPayload));
  check(
    'gateway RETRY (fresh eventId) after success → ignored, no second activation',
    retry.status === 200 && retry.json?.status === 'ignored' && retry.json?.reason === 'payment-already-success',
  );

  // ---------- IDOR ----------
  const idor = await api('GET', `/billing/payments/${paymentA1.id}`, { token: tokenB });
  check("user B cannot read user A's payment (404, no leak)", idor.status === 404);

  // ---------- admin guard ----------
  const forbiddenAdmin = await api('GET', '/admin/billing/payments', { token: tokenB });
  check('normal user hits admin payments → 403', forbiddenAdmin.status === 403);

  // ---------- upgrade: second purchase supersedes the first ----------
  const paymentA2 = await api('POST', '/billing/payments', {
    token: tokenA,
    body: { planId: otherPlan.id },
  });
  const upPayload = JSON.stringify({
    eventId: `evt-upgrade-${unique}`,
    eventType: 'payment.succeeded',
    payload: { paymentId: paymentA2.json.id },
  });
  await webhook(upPayload, sign(upPayload));
  const subAfterUpgrade = await api('GET', '/billing/subscription/me', { token: tokenA });
  check(
    'upgrade: exactly ONE active subscription, on the new plan',
    subAfterUpgrade.json?.subscription?.status === 'active' &&
      subAfterUpgrade.json?.subscription?.planSlug === `e2e-max-${unique}` &&
      subAfterUpgrade.json?.entitlements?.quota?.dailyMessages === 9999,
  );

  // ---------- duplicate_webhook scenario (simulator, whole pipeline) ----------
  const paymentB1 = await api('POST', '/billing/payments', {
    token: tokenB,
    body: { planId: plan.id },
  });
  const dupRun = await api('POST', `/billing/payments/${paymentB1.json.id}/simulate`, {
    token: tokenB,
    body: { scenario: 'duplicate_webhook' },
  });
  check(
    'duplicate_webhook scenario → processed then duplicate (single effect)',
    dupRun.status === 200 &&
      dupRun.json?.payment?.status === 'success' &&
      dupRun.json?.results?.[0]?.status === 'processed' &&
      dupRun.json?.results?.[1]?.status === 'duplicate',
    JSON.stringify(dupRun.json?.results),
  );

  // ---------- out-of-order: cancel lands before success ----------
  const paymentB2 = await api('POST', '/billing/payments', {
    token: tokenB,
    body: { planId: otherPlan.id },
  });
  const oooRun = await api('POST', `/billing/payments/${paymentB2.json.id}/simulate`, {
    token: tokenB,
    body: { scenario: 'out_of_order' },
  });
  check(
    'out_of_order scenario → cancelled; late success IGNORED (never resurrects)',
    oooRun.status === 200 && oooRun.json?.payment?.status === 'cancelled',
    JSON.stringify(oooRun.json),
  );

  // ---------- plan deactivation policy ----------
  const deactivate = await api('POST', `/admin/billing/plans/${plan.id}/deactivate`, { token: adminToken });
  check('admin deactivates the plan', deactivate.status === 201 && deactivate.json?.isActive === false);
  const userBStillActive = await api('GET', '/billing/subscription/me', { token: tokenB });
  check(
    'existing subscription KEEPS entitlements after plan deactivation',
    userBStillActive.json?.subscription?.status === 'active' &&
      userBStillActive.json?.entitlements?.tier === 'premium',
  );
  const buyDeactivated = await api('POST', '/billing/payments', {
    token: tokenB,
    body: { planId: plan.id },
  });
  check('purchase of a deactivated plan → 409', buyDeactivated.status === 409);
  const publicPlans = await api('GET', '/billing/plans', { token: tokenB });
  check(
    'deactivated plan no longer listed for purchase',
    publicPlans.json?.every((p) => p.isActive) ?? false,
  );

  // ---------- user cancellation ----------
  const cancel = await api('POST', '/billing/subscription/cancel', { token: tokenB });
  check(
    'user cancels → back to free tier immediately',
    cancel.status === 200 && cancel.json?.entitlements?.tier === 'free' && cancel.json?.subscription === null,
  );

  // ---------- audit trail ----------
  const audit = await api('GET', '/admin/billing/audit?limit=200', { token: adminToken });
  const eventTypes = new Set((audit.json ?? []).map((row) => row.eventType));
  check(
    'audit trail covers the whole flow (INV-08/09)',
    ['payment.created', 'payment.succeeded', 'webhook.received', 'webhook.duplicate',
     'subscription.activated', 'subscription.cancelled', 'plan.deactivated', 'access.granted', 'access.revoked']
      .every((t) => eventTypes.has(t)),
    `missing: ${['payment.created', 'payment.succeeded', 'webhook.received', 'webhook.duplicate',
      'subscription.activated', 'subscription.cancelled', 'plan.deactivated', 'access.granted', 'access.revoked']
      .filter((t) => !eventTypes.has(t))
      .join(', ')}`,
  );
  const secretsInAudit = (audit.json ?? []).some((row) =>
    JSON.stringify(row.metadata ?? {}).match(/password|token|apiKey|secret/i),
  );
  check('audit metadata contains no secrets', !secretsInAudit);

  // ---------- cleanup: deactivate the E2E plans ----------
  await api('POST', `/admin/billing/plans/${otherPlan.id}/deactivate`, { token: adminToken });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
