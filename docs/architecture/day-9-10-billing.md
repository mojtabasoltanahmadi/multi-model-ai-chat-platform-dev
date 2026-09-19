# Day 9-10 — Subscription / Payment Subsystem (Commercialization)

Scope: subscription plans, dynamic plan management, payment gateway simulator,
payment state machine, webhook processing with idempotency, subscription
lifecycle, entitlement-based access enforcement, payment history, audit
logging, and admin management. Chat Sharing / Frozen Snapshot is NOT part of
this document (separate teammate/task).

> This document supersedes the Day 7-8 non-goal "Billing, payments …" —
> plans are no longer admin-set flags. `users.plan` ('free' | 'premium')
> remains only as a denormalized display flag kept in sync by the billing
> subsystem; ALL access decisions read the subscription + plan rows.

---

## 1. Data Model (new tables)

| Table | Purpose | Key constraints |
|---|---|---|
| `plans` | Admin-managed plan catalog: price, currency, billing period (monthly/yearly → 30/365 days), daily message quota, optional daily token cap, allowed model ids (null = all), web-search/thinking/file-processing flags, active flag. | `slug` unique, immutable after creation. |
| `subscriptions` | One row per purchase; lifecycle pending → active → expired/cancelled. | **Partial unique index** `(user_id) WHERE status='active'` — INV-01 (at most one active subscription per user). |
| `payments` | Purchase attempts; amount resolved server-side from the Plan row. | Explicit state machine; **partial unique index** `(user_id, plan_id) WHERE status='pending'` — the double-click guard. |
| `webhook_events` | Gateway inbox: eventId, provider, eventType, payload, status (received/processed/ignored/failed). | **Composite unique** `(provider, event_id)` — INV-02 anchor. |
| `audit_logs` | Append-only trail (INV-08). | No update/delete path exists in the application. |

Money columns are `numeric(14,6)` returned as strings (same as usage costs).
`payments.plan_snapshot` (jsonb) freezes planId/slug/name/price/currency/
billing period at purchase time — INV-07: admin price changes never rewrite
history.

## 2. Entitlements / Access Policy (INV-05, INV-06)

`EntitlementsService.resolveForUser(userId)` is the single access chokepoint,
resolved FRESH from the database on every request (never from the JWT):

- **Active subscription** (period not ended) → tier `'premium'`, quotas and
  feature flags from its Plan row, optional `allowedModelIds` allowlist.
- **No active subscription** → tier `'free'` with the env-configured free-tier
  limits (`QUOTA_FREE_*`) and pre-billing feature behavior (web search,
  thinking and file processing allowed; free-model rule unchanged in
  `ModelsService.resolveChatModel`).

Integration points (all server-side):

- `MessagesService.assertChatTurnAllowed` resolves entitlements, then enforces:
  model allowlist (403), web-search entitlement (403 when `webSearch: true`
  requested), reasoning-model entitlement (403), file-attachment entitlement
  (403). Admins bypass the feature gates (like quotas) but not the allowlist
  or model-state checks.
- `QuotaService.assertQuota/snapshotFor` accept an optional `PlanQuota`
  override — subscription plans drive real limits; without it behavior is
  byte-identical to before.
- `GET /usage/me` reports the entitlement snapshot (plan tier + quota).

## 3. Expiration & Deactivation (documented policies)

- **Lazy expiration (INV-06):** entitlement resolution expires overdue active
  periods transactionally (`expireIfDue`: pessimistic lock + state re-check,
  audits `subscription.expired` + `access.revoked`, syncs `users.plan`).
  No cron/queue needed for the MVP; a scheduled sweeper can be added later
  without contract changes.
- **Plan deactivation:** a deactivated plan cannot be purchased (409 on
  create-payment) but existing active subscriptions run to their period end;
  historical payments are untouched. Re-activation simply re-opens purchases.
- **Renewal/upgrade:** a new successful payment closes any previous active
  subscription (status `cancelled`, reason `superseded-by-new-payment`) and
  creates a fresh ACTIVE row — expired/cancelled rows are never mutated.
- **User cancellation:** immediate (no proration) — `POST /billing/subscription/cancel`.

## 4. Payment Flow & State Machines

```
POST /api/billing/payments {planId}        ← client sends NO money values
  → plan must be active; amount/currency copied from the Plan row
  → duplicate pending (user, plan) returns the existing payment (double-click)
  → audit payment.created

POST /api/billing/payments/:id/simulate {scenario}   (MVP simulator)
  → success | failed | cancelled | timeout | duplicate_webhook | retry
    | out_of_order | unknown
  → signed gateway event(s) → WebhookService.processEvent (same pipeline
    as the HTTP webhook)

POST /api/billing/webhook  (@Public, HMAC-SHA256 over the RAW body —
                            header `x-hooshyar-signature`; 401 on mismatch)
```

Payment transitions: `pending → success | failed | cancelled`; terminal
states are immutable (`assertPaymentTransition`). Subscription transitions:
`pending → active | cancelled`, `active → expired | cancelled`.

### Webhook pipeline (INV-02 / INV-03 / INV-04)

One transaction:
1. INSERT into `webhook_events` — losing the `(provider, event_id)` race
   returns `duplicate` with ZERO business effect (concurrent-safe: the unique
   index is the arbiter, the service only interprets it).
2. `SELECT payment FOR UPDATE` — concurrent events for one payment serialize.
3. Apply the payment state machine; a stale event (late success after
   cancelled/failed/succeeded) is `ignored`, never resurrects anything.
4. On success: transition payment → activate subscription (close previous
   active) → sync `users.plan` → audit — all atomic (INV-03).
5. Mark the inbox row processed/ignored.

Unknown event types are acknowledged as `ignored` (200 — the gateway must
not retry them); forged/unsigned requests are 401 and never touch the DB;
replays answer 200 `duplicate`.

## 5. Security

- Client price manipulation is impossible: the DTO carries only `planId`.
- IDOR: user payment endpoints scope by the JWT user; a foreign payment is a
  404 indistinguishable from a missing one.
- Webhook authenticity: HMAC-SHA256 (constant-time compare) over the exact
  request bytes (`NestFactory.create(..., { rawBody: true })`).
- Admin endpoints: class-level `@Roles('admin')` (`admin/billing/*`).
- Audit metadata never contains secrets/credentials (INV-08: insert-only).

## 6. MVP Decisions / Limitations

- **Gateway simulator** replaces a real provider: `PaymentGatewaySimulatorService`
  produces gateway-shaped, correctly-signed events through the production
  pipeline. The HTTP webhook contract does not change when a real gateway
  arrives; the simulate endpoint should then be removed/feature-flagged.
- **Currency** default `IRT` (تومان) matching the existing cost display; admin
  can set any short code. No multi-currency conversion.
- **`users.plan`** stays in sync (activation → `premium`; expiry/cancel →
  `free`) for the existing admin views and sidebar badge only.
- **No proration / no invoices / no refunds** — payment history is the record.
- **Timeout scenario** leaves the payment `pending` (user may retry via a new
  event or cancel the checkout); there is no auto-expiry sweep for stale
  pending payments yet.
- Audit is best-effort outside business transactions (never breaks user
  flows) and transactional for activation/expiration.

## 7. API Summary

User (`/api/billing`): `GET plans`, `GET subscription/me`,
`POST subscription/cancel`, `POST payments`, `GET payments`,
`GET payments/:id`, `POST payments/:id/cancel`, `POST payments/:id/simulate` (MVP).
Public: `POST /api/billing/webhook`.
Admin (`/api/admin/billing`): `GET/POST plans`, `PATCH plans/:id`,
`POST plans/:id/activate|deactivate`, `GET payments`, `GET subscriptions`,
`GET audit`.

## 8. Chat Sharing / Frozen Snapshot

NOT IMPLEMENTED BY THIS TASK. No conversation/message/share code was touched;
the billing module has no dependency on conversations beyond the existing
chat pre-flight hook.

## 9. Verification

- **Unit (Jest, colocated `*.spec.ts`)**: ~50 billing tests — state machines,
  idempotency/concurrency (unique-inbox race), lazy expiration, entitlement
  resolution, plan deactivation policy, audit best-effort/transactional split,
  HMAC verification, simulator scenarios, chat pre-flight feature gates.
- **Integration/E2E (`scripts/billing-test.mjs`)**: requires a running backend
  (`node scripts/billing-test.mjs`, `API_BASE` overridable). 28 checks over
  the real HTTP surface: purchase → webhook → activation → entitlements →
  `/usage/me`, upgrade supersession, double-click dedupe, HTTP-level replay
  (same eventId twice), forged/unsigned webhook 401, malformed body 400,
  unknown event ignored, retry-after-success ignored, client price
  manipulation ignored, IDOR 404, user→admin 403, deactivated-plan 409 +
  delisting, user cancel → free tier, audit coverage + no secrets.
- **Visual**: subscription + admin billing pages reviewed against the design
  system (see DESIGN_SYSTEM.md §22a).
