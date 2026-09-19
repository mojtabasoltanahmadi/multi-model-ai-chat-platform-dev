# API Reference

Base URL: `http://localhost:4000/api` (through the Vite dev proxy: `/api` on port 5200).

All routes require `Authorization: Bearer <token>` **except** the public ones
(register/login, the HMAC-signed payment webhook and the theme availability list).
Validation errors return `400` with `{ "message": string | string[] }`.
Ownership violations return `404` (resource hidden, not forbidden).

## Auth (public)

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `{ email, password }` | 201 `{ accessToken, user }`; 409 duplicate email; password ≥ 8 chars |
| POST | `/auth/login` | `{ email, password }` | 200 `{ accessToken, user }`; 401 same message for unknown email / wrong password |

JWT payload: `{ sub: userId, email, role }`, expires in `JWT_EXPIRES_IN` (default 1d).

## Conversations

| Method | Path | Notes |
|---|---|---|
| GET | `/conversations` | caller's conversations, newest first |
| POST | `/conversations` | body `{ title? }` (empty body allowed → «گفتگوی جدید») |
| GET | `/conversations/:conversationId` | `{ conversation, messages }` (messages oldest first) |

## Messages (streaming)

`POST /conversations/:conversationId/messages` — body `{ content, modelId?, clientMessageId?, webSearch? }`

- `content` must be non-blank, ≤ 4000 chars (validated at the boundary)
- `modelId` optional; must reference a model that is **active** (and **free** for FREE-plan
  callers) — otherwise the default model is used. Authorization is re-checked on every send
  against current backend state; the frontend is never trusted (403 for a premium model
  requested by a FREE user, even via direct API calls).
- `clientMessageId` optional; opaque client-generated token (≤ 64 chars) used for idempotency.
  The same value may also be sent as the `Idempotency-Key` HTTP header — both are accepted,
  the header is just a convenience for proxies and replay logs.
- `fileIds` optional; up to 6 **`READY`** files **of this conversation** whose extracted text is
  added to the prompt. Any id that is unknown, belongs to another conversation/user, or is not
  `READY` rejects the send with 400 (before the stream starts). See
  [FILES.md](FILES.md#chat-integration).
- `webSearch` optional boolean (default `false`); when `true` the backend runs a live web
  search (Serper for the MVP) and injects the results into the model prompt. Omitted/false
  turns never call a search API. See [Web search](#web-search).

### Pre-flight

All 4xx-class errors (auth, ownership, plan, model state, **idempotency content collision**)
are caught by `MessagesService.assertChatTurnAllowed` **before** the SSE headers are
flushed. The frontend never sees an orphan SSE response carrying a JSON error.

| Failure | Status | Body |
|---|---|---|
| Unknown / foreign conversation | 404 | `{ message }` |
| Unknown model id | 404 | `{ message }` |
| Inactive model | 400 | `{ message }` |
| Model not allowed for caller's plan | 403 | `{ message }` |
| `clientMessageId` matches an existing user row whose `content` differs | 400 | `{ message: "این پیام قبلاً با متن دیگری ارسال شده است." }` |

### Success — 200 `text/event-stream`

Exactly one assistant message row is persisted per turn in every outcome, including failure.
The order of events on a normal run:

```
event: meta
data: {
  "userMessage":      { id, role: "user", content, status: null, ... },
  "assistantMessage": { id, role: "assistant", content: "", status: "pending", ... },
  "model":            { id, name, provider },
  "replay":           false
}

event: delta
data: { "text": "chunk" }     // repeated as the provider streams

event: done
data: { "assistantMessage": { status: "completed", content, ... } }
```

`meta` carries the real `assistantMessage.id` so the client can swap its placeholder for
the persisted row immediately (no race between optimistic UI and DB state).

### Web search

Opt-in per turn via `webSearch: true`. Lifecycle on a searched turn:

```
event: meta
event: search_started
data: {}
event: search_completed
data: { "resultCount": 5, "warning": null }
event: delta            // answer streams as usual
...
event: done
data: { "assistantMessage": { status: "completed", sources: [...], ... } }
```

- The search runs inside the detached generation loop, before the AI call: the client
  shows «در حال جستجو در وب…», then «N منبع پیدا شد», then the answer streams.
- `warning` (non-null) means the search degraded — the answer below was produced
  **without** web context (timeout, rate limit, network, empty results, missing key).
  The turn still completes; the client surfaces the warning once.
- Sources are persisted on the assistant row (`messages.sources`, jsonb) and echoed in
  `done`/`failed` payloads, so history reloads render citations without re-searching.
  Search runs only for new turns with `webSearch: true` — never on history load.
- Backend enforcement: the global `WEB_SEARCH_ENABLED` kill-switch gates the provider
  call (a client flag alone is never sufficient); all chat endpoints already require
  authentication. Only `http:`/`https:` URLs are persisted or linked.
- Environment: `WEB_SEARCH_ENABLED`, `WEB_SEARCH_PROVIDER=serper`, `SERPER_API_KEY`
  (secret — `.env` only, never committed), `WEB_SEARCH_MAX_RESULTS` (default 5),
  `WEB_SEARCH_TIMEOUT_MS` (default 5000), `WEB_SEARCH_MAX_QUERY_LENGTH` (default 500),
  `WEB_SEARCH_MAX_CONTEXT_CHARS` (default 6000). Without a key the turn degrades with
  a safe warning; nothing throws and no secret is ever logged or returned.

```ts
interface MessageSource { title: string; url: string; domain: string; snippet: string; }
```

### Replay

A `clientMessageId` that matches an existing user row **with the same content** is treated
as a retry: the existing user row is reused (no duplicate), a **fresh** assistant row is
created, and `meta.replay = true`. The body of the request must match the original
character-for-character; see the `400` row above for the mismatch path.

### Failure paths

Provider error (timeout, 5xx, refused connection). Partial content is persisted with
`status: "failed"` and a server-side `errorMessage`. The client receives a non-leaky
generic message:

```
event: failed
data: { "assistantMessage": { status: "failed", ... }, "message": "سرویس هوش مصنوعی موقتاً در دسترس نیست. لطفاً دوباره تلاش کنید." }
```

Client disconnect (browser tab closed, network dropped, refresh). **No error event is
emitted and the generation is NOT stopped** — disconnect ≠ failure. The HTTP connection
merely unsubscribes from the generation; the AI loop keeps running, keeps persisting
progress, and the row finishes as `status: "completed"`. A client that went away can
re-attach via the reconnect endpoint below and receive the rest of the answer without
regenerating anything.

The full state machine and disambiguation rules live in
[CONVERSATION_RESILIENCE.md](CONVERSATION_RESILIENCE.md).

### Reconnect / recovery stream

`GET /conversations/:conversationId/messages/:messageId/stream` — the recovery stream
for a client that lost its live connection (refresh mid-stream, closed tab, network
drop, or a second tab opening the same conversation).

Pre-flight (before SSE headers): 404 for an unknown/foreign conversation or a message
that is not an assistant row of that conversation.

Events, in order:

```
event: snapshot
data: { "assistantMessage": { content: "<full content so far>", status, ... } }

// live generation only:
event: delta
data: { "text": "chunk" }      // the remaining deltas, never overlapping the snapshot

// always exactly one terminal event:
event: done
  → { "assistantMessage": { status: "completed", ... } }
event: failed
  → { "assistantMessage": { status: "failed" | "interrupted", ... }, "message": "<generic>" }
```

Recovery behavior by row state:

| Row state on the server | Behavior |
|---|---|
| Live generation in progress | `snapshot` + remaining `delta`s + terminal. The client joins the **same** generation — the AI is never re-invoked. |
| `completed` | `snapshot` + `done`. Pure replay, no AI call. |
| `failed` | `snapshot` + `failed` (generic message). Retry is a user action. |
| `interrupted` (user pressed Stop) | `snapshot` + `failed` (generic message). Retry is a user action. |
| `pending`/`streaming` with **no** live generation (server restarted mid-generation) | The row is honestly marked `interrupted` in the DB, then `snapshot` + `failed` with a "you can retry" message. No fake resume. |

Snapshot/delta ordering guarantee: the server subscribes the reconnecting client
**before** reading its content buffer, so a token is either in the snapshot or in a
delta — never both, never neither. `snapshot + deltas` concatenates exactly to the
persisted content.

### Message shape

```ts
type MessageStatus = 'pending' | 'streaming' | 'completed' | 'interrupted' | 'failed';

interface Message {
  id: string;                  // uuid
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus | null;  // null on user rows
  errorMessage: string | null;   // server-side detail, never leaked to client
  modelId: string | null;
  clientMessageId: string | null; // user rows only
  sources: MessageSource[] | null; // assistant rows answered with web search
  createdAt: string;             // ISO
}
```

## Files

| Method | Path | Notes |
|---|---|---|
| POST | `/conversations/:conversationId/files` | `multipart/form-data`, field `file`. **201** with the safe file shape. Foreign conversation → 404; empty/unsupported/mismatched content → 400; over the size limit → 413. Extraction never happens in this request. |
| GET | `/conversations/:conversationId/files` | files of one conversation, oldest first (used to restore statuses after a refresh) |
| GET | `/files/:fileId` | one file — the polling endpoint; foreign file → 404 |
| GET | `/files/:fileId/content` | owner-only bytes used for thumbnails, the preview viewer and downloads. Images/PDF are `Content-Disposition: inline` (plus `X-Content-Type-Options: nosniff`); everything else, or `?download=1`, is an `attachment`, with the original name echoed as `filename*=UTF-8''…` so non-ASCII names survive. Foreign file → 404, missing object → 404, no token → 401. |
| GET | `/admin/files?status=&limit=&offset=` | **admin** — `{ total, counts: {UPLOADING, PROCESSING, READY, FAILED, total}, items[] }` with user email + conversation title |
| GET | `/admin/files/stats` | **admin** — `{ counts, queue: { waiting, active, failed, completed } \| null }` |
| POST | `/admin/files/:fileId/reprocess` | **admin** — the only path from `READY`/`FAILED` back to `PROCESSING`; 400 for any other status |

Safe file shape (never includes extracted text or the storage key):

```ts
{
  id: string;
  userId: string;
  conversationId: string;
  originalName: string;      // sanitized display name
  mimeType: string;          // resolved from content, not the client claim
  size: number;
  status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED';
  errorMessage: string | null; // safe reason, set when FAILED
  attempts: number;
  createdAt: string;         // ISO
  updatedAt: string;         // ISO — changes when the status changes
}
```

Upload limits and lifecycle: [FILES.md](FILES.md).

## Models (authenticated)

| Method | Path | Notes |
|---|---|---|
| GET | `/models` | models the **caller's plan** may use — currently **active AND free** (the plan-filtered list for the chat picker; never the full catalog) |

## Admin models (`role=admin` only)

Provider kinds (one registered adapter each, `backend/src/ai/adapters/`):
`mock` (canned demo stream, no key) · `openai-compatible` (any OpenAI-style
streaming `/chat/completions`) · `anthropic` (Claude Messages API) ·
`google` (Gemini `streamGenerateContent`). Model rows additionally carry
`capabilities` — a closed set (`web-search`, `reasoning`) validated at this
boundary and surfaced in every model response (picker glyphs, admin panel).

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/models` | all models; `apiKey` never returned, `hasApiKey` instead |
| POST | `/admin/models` | `{ name, provider: 'mock'\|'openai-compatible'\|'anthropic'\|'google', externalModelId, baseUrl?, apiKey?, capabilities?, inputPricePerMillion?, outputPricePerMillion?, isActive?, isFree? }`; the first active+free model auto-becomes default |
| PATCH | `/admin/models/:modelId` | partial update (incl. `isFree`, `capabilities`, pricing); deactivating the default is refused (400); removing free access from the default is refused (400) |
| POST | `/admin/models/:modelId/default` | transactional swap; exactly one default; inactive or non-free models refused (400) |
| DELETE | `/admin/models/:modelId` | default model deletion refused (400) |

## Themes (public)

Theme availability is admin-controlled server state (the `themes` table, seeded from
`backend/src/themes/theme-registry.ts`). The frontend never hardcodes which themes
users may pick; visual definitions (tokens, preview palettes) live in
`frontend/src/themes/registry.ts` and are keyed by the same stable ids.

| Method | Path | Notes |
|---|---|---|
| GET | `/themes/available` | **public** — enabled themes in display order (`{ id, name, description, isDefault, sortOrder }[]`); exactly one `isDefault: true` (invariant, auto-repaired on boot) |

## Preferences (authenticated)

Server-synced user preferences in the `user_preferences` table (one row per user,
created lazily). A concrete theme choice syncs across devices; the device-local
`system` preference is never stored server-side.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/users/me/preferences` | — | `{ themeId: string \| null }`; `null` = never chosen (client keeps its local choice). A stored theme disabled since selection resolves to the system default before it is returned |
| PATCH | `/users/me/preferences/theme` | `{ themeId }` | `{ themeId }`; 400 when the theme is unknown or currently disabled — the disabled-theme list is never selectable through the API |

## Admin themes (`role=admin` only)

Ids are stable registry keys (`light` \| `dark` \| `midnight`), not UUIDs; unknown ids → 404.
Invariants (service-enforced): at least one enabled theme, exactly one default and a
default is always enabled. Disabling the current default auto-moves the default to the
first remaining enabled theme; disabling the last enabled theme is refused (400); setting
a disabled theme as default is refused (400).

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/admin/themes` | — | all themes in display order (incl. disabled) |
| PATCH | `/admin/themes/:themeId` | `{ name?, description?, sortOrder? }` | display metadata edits |
| PATCH | `/admin/themes/:themeId/status` | `{ enabled }` | enable/disable (see invariants above) |
| POST | `/admin/themes/:themeId/default` | — | transactional swap; exactly one default |
| POST | `/admin/themes/reorder` | `{ themeIds }` | complete ordered list of ALL registry ids; duplicates/partial lists refused (400) |

## Usage & quota (authenticated)

One usage row per ACCEPTED chat turn is written atomically with the user
message row (`message_id` UNIQUE — replays can never double-record). The row
is terminal-updated exactly once (`completed | failed | interrupted`; tokens
provider-reported or `chars/4`-estimated with `estimated=true`; cost in Toman
from the model's per-1M pricing, `null` when unpriced). Reconnects touch
nothing. **Failed turns are recorded but do not consume the message quota.**

| Method | Path | Notes |
|---|---|---|
| GET | `/usage/me` | `{ plan, quota: { dailyMessages, dailyTokens \| null } \| null, today: { used, remaining, tokens } }`; `quota: null` for admins |
| GET | `/admin/users` | admin-only list `{ id, email, role, plan, createdAt }` |
| PATCH | `/admin/users/:userId/plan` | `{ plan: 'free'\|'premium' }` → `{ id, email, plan }`; takes effect on the user's NEXT request (plan is never read from the JWT) |
| GET | `/admin/usage/summary?days=7` | admin-only `{ days, totals: { turns, failedTurns, inputTokens, outputTokens, totalTokens, estimatedCost }, perDay[], perModel[], perUser[] }` (1 ≤ days ≤ 90; includes failed turns — cost reporting shows real consumption) |

Quota limits are env-configured per deployment (`QUOTA_FREE_DAILY_MESSAGES`
default 50, `QUOTA_PREMIUM_DAILY_MESSAGES` default 500, optional
`QUOTA_FREE_DAILY_TOKENS` / `QUOTA_PREMIUM_DAILY_TOKENS`) — the MVP mechanism
for "admin-defined limits". The quota window is the current UTC day.

Provider failure behavior (all adapters): failures are normalized to a closed
kind set (`timeout`, `rate-limit`, `unavailable`, `auth`, `invalid-request`,
`invalid-config`, `unknown`). A turn whose provider fails is persisted as a
`failed` message with the two existing safe Persian sentences (timeout vs
generic); internal detail stays in server logs. A missing API key fails fast
as `invalid-config` (never retried, no mid-stream surprise).

## Billing (authenticated)

Subscription/payment surface (day 9-10; decisions in `docs/architecture/day-9-10-billing.md`).
Every price and entitlement is resolved server-side from the `plans`/`subscriptions`
rows — client-sent money values do not exist in the flow. Users without an active
subscription are on the env-configured free tier (same limits as before billing).

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/billing/plans` | — | active plans, cheapest first (`Plan[]`) |
| GET | `/billing/subscription/me` | — | `{ entitlements, subscription }` — the server-resolved access snapshot (tier, quota, feature flags, model allowlist) + the active subscription row (null when none) |
| POST | `/billing/subscription/cancel` | — | immediate cancellation → back to free tier; response = fresh `{ entitlements, subscription }` |
| POST | `/billing/payments` | `{ planId }` | 201 `UserPaymentView` (`pending`). Amount/currency are copied from the Plan row — any client-sent price fields are ignored. A second pending payment for the same (user, plan) returns the existing one (double-click dedupe) |
| GET | `/billing/payments` | — | caller's payment history, newest first |
| GET | `/billing/payments/:paymentId` | — | owned payment detail — another user's payment is a 404 (IDOR-safe, no existence leak) |
| POST | `/billing/payments/:paymentId/cancel` | — | abort a `pending` checkout (terminal states are immutable) |
| POST | `/billing/payments/:paymentId/simulate` | `{ scenario }` | MVP gateway simulator: `success` `failed` `cancelled` `timeout` `duplicate_webhook` `retry` `out_of_order` `unknown`. Runs signed gateway event(s) through the real webhook pipeline; returns `{ scenario, payment, results }` |

Payment status: `pending → success | failed | cancelled` (explicit state machine;
terminal states never change — a late webhook on a terminal payment is `ignored`).

## Payment webhook (public)

`POST /billing/webhook` — gateway callback. Authenticated by an **HMAC-SHA256 hex
signature over the exact raw request bytes** in header `x-hooshyar-signature`
(shared secret: `PAYMENT_WEBHOOK_SECRET`). Body: `{ eventId, eventType, payload }`
with `eventType ∈ payment.succeeded | payment.failed | payment.cancelled`.

- forged/unsigned → **401** and the event never touches the database
- malformed body → **400** (even with a valid signature)
- first delivery → **200** `{ received: true, status: "processed" }` — the payment
  transitions AND the subscription activates atomically in one transaction
- replay (same `eventId`, unique per provider) → **200** `status: "duplicate"`
  with zero business effect (INV-02/04)
- unknown event type or stale payment state → **200** `status: "ignored"`

## Admin billing (`role=admin` only)

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/billing/plans` | all plans incl. inactive |
| POST | `/admin/billing/plans` | create (`CreatePlanDto`); `slug` unique + immutable afterwards; 409 duplicate slug |
| PATCH | `/admin/billing/plans/:planId` | partial update; price changes affect only FUTURE payments (INV-07 snapshot) |
| POST | `/admin/billing/plans/:planId/activate` / `deactivate` | deactivation stops new purchases (409 on buy); existing subscriptions run to period end; history untouched |
| GET | `/admin/billing/payments?userId&status&limit` | full payment rows (incl. userId + plan snapshot) |
| GET | `/admin/billing/subscriptions?userId&status&limit` | subscription overview |
| GET | `/admin/billing/audit?eventType&userId&limit` | append-only audit trail (no update/delete path exists) |

## Error semantics

| Status | Meaning |
|---|---|
| 400 | validation failure (empty/long message, bad UUID, inactive model, default-model rule incl. free access, idempotency content collision, file content/MIME/extension mismatch, attached file not `READY` or foreign, illegal file status transition, reprocess of a non-terminal file, invalid plan value, theme rules (disabled/last-enabled theme status change, default-ing a disabled theme, bad reorder list, selecting a disabled theme)) |
| 403 | forbidden (role-gated endpoints; model not allowed for the caller's plan) |
| 429 | daily quota exhausted pre-stream — messages «سهمیه پیام‌های امروز شما تمام شده است.» or tokens «سهمیه توکن‌های امروز شما تمام شده است.»; admins and idempotent replays are exempt |
| 401 | missing/invalid/expired JWT; invalid/missing payment-webhook HMAC signature |
| 403 | authenticated but insufficient role — or a model the caller's plan is not allowed to use |
| 404 | unknown or foreign resource (no existence leak) |
| 409 | duplicate email on register; duplicate plan slug; purchase of a deactivated plan; state-machine violation on a terminal payment/subscription mutation |
| 413 | uploaded file exceeds `FILE_MAX_SIZE_BYTES` (rejected by multer before the handler runs) |
| 500 | unexpected error (clean JSON, details only in server logs) |
