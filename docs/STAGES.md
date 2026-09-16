# Implementation Stages

A running log of what was built, the decisions taken, and how each stage was verified.
(See [ARCHITECTURE.md](ARCHITECTURE.md) for the resulting system and [API.md](API.md) for endpoints.)

## Stage 0 — Scaffolding

- git init, `.gitignore` (env files, logs, dist, node_modules), fresh `ai_chat_mvp` database.
- Chose ports 4000 (backend) / 5200 (frontend) because 3000/5173 were already used
  by other projects on this machine.

## Stage 1 — Backend core: entities, auth, security defaults

- Entities: `users`, `conversations`, `messages`, `ai_models` with FK constraints
  (`CASCADE` down the ownership chain, `SET NULL` for message→model).
- Auth: register/login with bcrypt hashing, normalized (lower-cased) emails, identical
  error for unknown user vs. wrong password, JWT (1 day), admin account seeded from env
  on first boot.
- Security defaults: global `JwtAuthGuard` + `RolesGuard` + global `ValidationPipe`
  (whitelist) + global exception filter returning clean Persian messages.

**Decisions**
- `@Public()` opt-out instead of per-route guards — secure by default is harder to get wrong.
- JWT claims normalized to `{ id, email, role }` on `request.user` (found via smoke test:
  `sub` vs `id` mismatch was silently inserting `NULL` owner ids).
- bcryptjs (pure JS) instead of native bcrypt — avoids Windows build toolchain issues.

**Issues found & fixed during verification**
- TypeORM duplicate columns: declaring both `@Column({name:'user_id'}) userId` and a bare
  `@ManyToOne user` produced two columns (`user_id` + auto `userId`) and the FK stayed NULL.
  Fixed with `@JoinColumn({ name: 'user_id' })` on all three FK relations.
- `@Index()` on a `@OneToMany` relation is invalid (index must live on the FK side).

## Stage 2 — Conversations, messages, SSE streaming

- Conversation list/create/get with **ownership inside the lookup** (`WHERE userId`),
  404 (not 403) for foreign resources so existence is not leaked.
- Chat turn endpoint streams SSE: `meta` → `delta`* → `done` / `error`.
- Boundary validation: non-blank content (custom `NotBlank` validator rejects `""` and
  `"   "`), ≤ 4000 chars, UUID params.
- One-assistant-message-per-turn invariant: a single row is created per turn and updated
  in memory; final save carries `status='completed' | 'error'` (+ partial content on failure).
- Client disconnects abort the provider call and persist the partial content with
  `status='error'` (distinguishable state per spec).
- First message auto-titles the conversation.

**Decisions**
- Single POST endpoint streams the answer directly (KISS) instead of separate
  create-message + stream endpoints.
- Pre-flight `assertChatTurnAllowed` runs **before** SSE headers open, so ownership/model
  errors reach clients as normal JSON errors.
- Provider history is rebuilt from persisted messages (conversation context survives restarts).

**Issues found & fixed during verification**
- `request.closed` is true once the body is consumed — it does NOT mean the client
  disconnected. Replaced with `response.destroyed / writableEnded`.
- NestJS applies its POST 201 default even with `@Res()`; the SSE handler now sets
  `status(HttpStatus.OK)` explicitly.

## Stage 3 — AI provider abstraction & model management

- `AiProviderService`: `mock` (chunked Persian canned answer; makes demos/tests work with
  zero external dependencies) and `openai-compatible` (streaming `fetch` + SSE parser,
  `AbortController` timeout at `AI_REQUEST_TIMEOUT_MS`).
- Admin endpoints: create / list / update / set-default / delete.
- Default-model invariant: transactional swap (clear all → set one); default cannot be
  deactivated or deleted; inactive model cannot become default; first active model
  auto-default; chat resolution refuses unknown/inactive models and a missing default.

**Decisions**
- API keys stored in DB, never returned (`hasApiKey` flag) — simple, adequate for MVP.
- Admin role checked via `@Roles('admin')` metadata, not a separate admin module.

## Stage 4 — Tests

- **43 Jest unit tests** over mocked repositories (run anywhere, no DB):
  auth (hashing, duplicates, wrong credentials, seeding), JWT guard (missing/invalid/expired/
  public), roles guard, conversation ownership, default-model invariants, streaming
  one-message invariant (success, provider error, client disconnect, titling, history).
- **48-check HTTP smoke test** (`scripts/smoke-test.mjs`, Node built-in fetch, uses the
  mock provider): the full black-box suite incl. UTF-8/emoji round-trip and a real
  unreachable-provider failure path. Runs against the backend directly or through the
  Vite proxy (the browser's path).

## Stage 5 — Frontend (Vue 3 + Vite, RTL)

- Login/Register, reactive auth store persisted in localStorage, router guards
  (guest-only / auth-required / admin-only).
- Chat view: conversation sidebar, model picker (active models only, default preselected),
  streaming display via `fetch` + ReadableStream SSE parser (EventSource cannot POST with
  a JWT), typing indicator, error banners, error-status bubbles for failed turns.
- Admin view: model CRUD-lite with Persian feedback for refused invariant violations.
- Vite dev proxy `/api` → `localhost:4000` (no CORS handling needed).

**Issues found & fixed during verification**
- Vite bound to IPv6-only loopback on this machine; pinned `host: '127.0.0.1'`.

## Stage 6 — Final verification

- Fresh reboot of both servers; backend direct 401 on protected route; Vite 200.
- `npx jest`: 43/43. Smoke test direct: 48/48. Smoke test through Vite proxy: 48/48.

## Stage 8 — UI/UX redesign: premium AI workspace (TypeScript)

The frontend was rebuilt to a commercial-grade design system per the UI brief and the
project's `UI_UX_RULES.md` / `DESIGN_SYSTEM.md` (backend untouched — all 48 API smoke
checks still pass).

- **TypeScript migration**: `vue-tsc` typecheck in `npm run build`; typed API layer
  (`src/api/types.ts`, `client.ts`) and typed SFCs throughout.
- **Design system**: layered CSS tokens (`src/styles/tokens.css`) — indigo accent,
  warm off-white light theme, intentionally-designed cool near-black dark theme.
  Theme preference (روشن/سیستم/تاریک) persisted, respects `prefers-color-scheme`,
  applied pre-paint (no FOUC).
- **Persian typography**: self-hosted Vazirmatn (@fontsource) + Inter for Latin
  fragments; `.ltr`/`.mono` utilities keep mixed RTL/LTR content stable.
- **Component library** (`ui/`): AppButton, AppInput (password reveal, validation),
  AppModal, ToastHost, AppSkeleton, AppAvatar, ThemeToggle, BrandMark, EmptyState/ErrorState.
- **Workspace layout** (`layout/AppSidebar.vue`): brand, new conversation, search,
  date-grouped conversation list, profile menu (theme/admin/logout); off-canvas drawer
  below 1024px.
- **Chat experience** (`chat/`): glassy header with model selector, branded empty state
  with 4 interactive prompt cards (create + send), markdown assistant messages with
  model attribution/timestamps/copy action, streaming caret + stop button, composer with
  autosize, focus ring, char counter, disabled attachment placeholder.
- **Admin experience** (`admin/`): skeleton loading, retry error state, dense table
  (cards on mobile), default/inactive visual states, modal form with provider radio
  cards, delete confirmation, toasts for outcomes.
- **Accessibility**: global `:focus-visible`, aria-live toasts, role=alert errors,
  aria-current/expanded semantics, reduced-motion support, ≥44px touch targets.
- **Deliberate MVP skips** (documented in DESIGN_SYSTEM.md decision log): regenerate
  action (no backend endpoint), file upload (visual placeholder only), settings page
  (profile menu covers theme/admin/logout).

**Verification**: `vue-tsc --noEmit` clean, production build clean, dev server serves
the new app (pre-paint theme script verified in HTML), backend 48/48 smoke checks pass
through the Vite proxy. Browser GUI testing could not run in this session (browser
automation runtime unavailable) — visual review pending a manual pass.

## Known limitations / future work

- `DB_SYNCHRONIZE` schema management — replace with migrations before any real deployment.
- Single access token, no refresh/rotation or logout invalidation.
- API keys unencrypted at rest.
- No rate limiting; no observability; k6 load test deliberately skipped (no requirement yet).
- Frontend browser-level GUI testing not yet automated (API layer fully covered by smoke tests).

## Stage 9 — Responsive hardening (320px–1440px)

Content-driven audit across all views and components found 8 concrete issues, each
fixed at the component level (no redesign, no new breakpoints — the existing
640/768/900/1024 system was reused):

1. Chat header title: `min-width: 0` so the ellipsis engages on narrow screens.
2. Composer textarea: `min-width: 0` (intrinsic width previously pushed the composer
   box past the viewport on mobile).
3. Model-selector pill: name ellipsized at 8.5rem; dropdown viewport-capped.
4. Modal panels: `max-height: calc(100dvh - 3rem)` + scrollable body.
5. Admin toolbar: wraps instead of overflowing at 320px.
6. Wide markdown tables: scroll inside the message column.
7. Mobile hamburger + drawer close: 2.5rem touch targets.
8. (Covered by 1–7: no horizontal overflow sources remain in audit.)

Verification: `vue-tsc` clean, build clean, all 8 rules asserted in built CSS chunks,
48/48 API smoke checks still pass. Rules documented in DESIGN_SYSTEM.md §16.

## Stage 10 — Free AI models & model switching

Goal: admins mark models as Free (usable on the FREE plan, the only plan in the MVP);
free users can only see and use models that are **active AND free**. Backend authorization
is the single source of truth.

**Backend**
- `ai_models.is_free` column (independent of `is_active`: free-configured but disabled is
  a valid state). Default `true` so existing rows stay usable.
- `ModelsService.listAvailable(plan)` returns only `isActive AND isFree` for the free plan —
  the plan-filtered picker list, never the full catalog.
- `ModelsService.resolveChatModel(modelId?, plan)` — the single chat authorization
  chokepoint, re-read on every send: unknown → 404, inactive → 400, not allowed for the
  plan → 403. Direct API calls with a premium `modelId` are rejected; concurrent admin
  changes are honored because state is read fresh per request.
- Default-model rules extended: default must be **active + free**. `setDefault` refuses
  inactive/non-free; deactivating, un-freeing, or deleting the default is refused (400);
  bootstrap auto-default only picks an active+free model.
- SSE serialization now includes `modelId` on streamed messages — each assistant message
  stays attributable to the model that produced it after a mid-conversation switch
  (history is never rewritten; model is stored per message, `SET NULL` on model delete).

**Frontend**
- Admin panel: `Free/Premium` badge (`ModelStatus`), a Free toggle switch per row
  (`ModelTable`), and an `isFree` switch in the create form (`ModelForm`). Backend
  refusals (e.g. un-freeing the default) surface as toasts.
- `AiModel` type carries `isFree`; create/update payloads accept it.

**Edge cases covered** (backend unit tests + `scripts/smoke-test.mjs`):
no active free models → picker shows the empty state (backend returns `[]` without
crashing); model deactivated or un-freed after selection → next send rejected with
400/403; unknown model id → 404; premium model via direct API call → 403; default
disabled/deleted → refused at the admin boundary, so a valid default always exists.

**Verification**: backend jest 55/55 (incl. new model-switching attribution test),
backend `tsc` clean, `vue-tsc` clean, both production builds clean. Smoke-test script
extended with free/premium authorization checks (run requires a live backend + DB).

**Decisions**
- No new entity: `isFree` on `ai_models` (spec: extend, don't create).
- No separate Free default: one default, constrained to active+free — simplest state
  that is always valid for free users.
- `UserPlan = 'free'` parameter kept on the service API so later plans plug into the
  same chokepoint without refactoring.

## Stage 11 — Conversation resilience (Day 3 + Day 4)

Goal: a chat turn survives every realistic interruption without losing the
user's intent and without orphaning AI text. Full spec:
[CONVERSATION_RESILIENCE.md](CONVERSATION_RESILIENCE.md).

**Backend — pre-persist + state machine**
- `assertChatTurnAllowed` runs all 4xx checks (auth, ownership, plan, model
  state, idempotency content collision) **before** SSE headers flush. No 4xx
  ever produces an orphan SSE response.
- Assistant row is pre-persisted with `status='pending'` immediately after
  the user row, before the first `meta` event. A reload between POST and
  first delta still finds the row.
- `messages.status` enum extended from `{completed, error}` to
  `{pending, streaming, completed, interrupted, failed}`.
- Disconnect vs failure disambiguation: the catch block asks
  `isClientDisconnected()` before classifying an `AbortError`. Client-side
  aborts become `interrupted` (no `error` event — the disconnector cannot
  receive it); genuine provider failures become `failed` and emit a generic
  client message.
- A post-loop `isClientDisconnected()` check handles the edge case where the
  client bails out before any delta arrives (the for-await body never runs,
  so the in-loop check is unreachable).

**Backend — idempotency**
- New `messages.client_message_id` column, indexed by
  `(conversation_id, role, client_message_id)`. Same token allowed across
  conversations.
- Reuse + matching content → replay (same user row, fresh assistant row,
  `meta.replay = true`).
- Reuse + mismatched content → 400 in pre-flight
  (`این پیام قبلاً با متن دیگری ارسال شده است.`).
- `Idempotency-Key` HTTP header accepted as a mirror of the body field, for
  proxies and replay logs.

**Frontend — types + API**
- `MessageStatus` union widened to match the backend.
- `Message` carries `clientMessageId` and `errorMessage`.
- `streamChatMessage` accepts `clientMessageId` and sends it on both the body
  and the `Idempotency-Key` header.
- `StreamMetaPayload` now includes `assistantMessage` (real id, `status='pending'`)
  and `replay: boolean`.

**Frontend — useOnline**
- New singleton composable wrapping `navigator.onLine` + the `online`/`offline`
  window events. Treated as a UI hint (banner), not a transport guarantee —
  every request still surfaces its own error.

**Frontend — ChatView**
- Last-opened conversation persisted in `localStorage` under
  `hooshyar.active-conversation` (UUID-validated; foreign ids silently cleared).
- Optimistic user row + streaming placeholder tagged `__streaming__`; the
  placeholder is replaced by the real row on the `meta` event.
- `newClientMessageId()` generates a `<prefix>-<base36 ts>-<rand>` token
  (≤ 64 chars) for every fresh send.
- `send(content, { clientMessageId? })` accepts a pre-existing id for Retry —
  the backend treats it as a replay.
- `stopStreaming()` marks the placeholder `interrupted` locally and triggers
  `loadMessages()` to reconcile with the DB.
- Offline banner slides in under the chat header with a pulsing red dot
  (`role="status"` `aria-live="polite"`).

**Frontend — MessageItem**
- New status variants: `interrupted` (italic muted) and `failed` (red
  surface with `errorMessage`).
- Retry button visible on `interrupted` / `failed`; disabled while another
  send is in flight.
- Retry calls `send(userRow.content, { clientMessageId: userRow.clientMessageId })`,
  removing the failed/interrupted assistant row first so the optimistic
  stream doesn't double the bubble.

**Edge cases covered**
(`scripts/smoke-test.mjs` 75 checks + `scripts/resilience-test.mjs` 14 checks +
backend Jest 63 specs):

- Pre-flight rejects idempotency content collision with 400 (no orphan SSE).
- Aborted mid-stream persists `status='interrupted'` with partial content.
- Disconnect BEFORE first delta persists `interrupted` (post-loop check).
- Provider timeout persists `failed` (not `interrupted`) — disambiguated.
- `Idempotency-Key` header round-trip = same as body field.
- Meta event carries the real `assistantMessage.id` and `replay` flag.
- Two-tab / refresh / retry all surface the last persisted state with no
  duplicate user row.

**Verification**: backend Jest 63/63 (incl. pre-flight + disambiguation specs),
backend `tsc` clean, `vue-tsc` clean, both production builds clean.
`scripts/smoke-test.mjs` 75/75 (incl. status='failed', idempotency reuse,
header round-trip, content-mismatch → 400). `scripts/resilience-test.mjs`
14/14 (real aborts, partial content kept, Retry semantics).

**Decisions**
- No WebSocket — SSE is enough for one-way streaming.
- No Redis / BullMQ / queue — the database is the durable buffer.
- `interrupted` vs `failed` as separate statuses (not collapsed) so the UI
  can show a generic "Retry" instead of an error toast when the user
  clicked Stop themselves.
- Idempotency is the only double-send mechanism — no per-tab locks, no
  per-user queues. The composite index is enough.
- Retry creates a new assistant row (no row mutation); a future
  "regenerate" surface will reuse the same code path with different copy.
- No client-side retry queue — Retry is a deliberate user action. We never
  silently re-send.

## Stage 12 — Detached generation + reconnect stream

Backend (commit 01021fd):
- `GenerationRegistry`: in-process fan-out of delta/done/failed events plus an
  authoritative content buffer for reconnect snapshots.
- `beginChatTurn` + detached `runGeneration`: the AI loop is decoupled from the
  HTTP response. Client disconnect (refresh, closed tab, network loss) only
  unsubscribes — the generation continues, persists progress (status flips to
  `streaming` on the first token; content flushed on a 1.5s throttle,
  `AI_PERSIST_INTERVAL_MS`), and always reaches a persisted terminal state.
- `GET /conversations/:id/messages/:messageId/stream`: recovery stream.
  Subscribe-first/snapshot-second ordering guarantees no token is lost or
  duplicated. Completed rows replay as snapshot+done without re-invoking the
  AI; orphaned pending/streaming rows (server restart) are honestly marked
  `interrupted` and offered for retry.
- Terminal SSE event renamed `error` → `failed` and now carries the persisted
  `assistantMessage` alongside the generic client message.

Frontend (commits 14fe127 and the follow-up hardening):
- `reconnectGenerationStream` client (GET SSE reader; snapshot REPLACES,
  deltas APPEND).
- ChatView: after every conversation load, the latest pending/streaming
  assistant row auto-attaches to the live generation. `activeStreamRowId`
  generalizes the streaming slot (optimistic placeholder or persisted row).
- Follow-up fixes: retry no longer duplicates the user bubble
  (`existingUserRowId`); a transport drop after deltas arrived no longer
  fabricates a `failed` row — tokens are kept, the row renders `interrupted`
  locally, and a `watch(online)` hook re-attaches to the same generation when
  connectivity returns; the SSE dispatcher handles the `failed` event name
  (previously only `error`, so terminal failures left the UI streaming
  forever); Stop no longer double-refreshes the sidebar.

Verification:
- backend jest 69/69
- scripts/smoke-test.mjs 75/75
- scripts/resilience-test.mjs 28/28 (rewritten for the detached contract:
  abort→completes, completed-replay, two-clients-one-generation with exact
  snapshot+delta equality, ownership 404s, replay row counts, pre-delta abort)
- vue-tsc --noEmit clean; frontend production build clean

Decisions:
- Snapshot-based reconnect instead of the drafted Last-Event-ID cursor design
  (docs/superpowers/specs/2026-09-15-conversation-stream-resume-design.md,
  marked superseded): no event ids, no ring buffer, no 410s, no schema change.
- No auto-retry-on-return: with detached generation there is no "interrupted
  on refresh" state to auto-retry; orphaned rows surface an explicit retry.
- Token-level provider resume is impossible with stateless completion APIs;
  the honest fallback (interrupted + retry) is documented, not faked.
