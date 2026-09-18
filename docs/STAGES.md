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
  action (no backend endpoint), file upload (visual placeholder only at the time — implemented in Stage 13), settings page
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
- (Stage 13) File worker is in-process; OCR is CPU-bound and single-language; no file
  preview/download; no extracted-text admin view. See [FILES.md](FILES.md).
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

## Stage 13 — File upload & asynchronous processing (Day 5–6)

Goal: attach PDF / Excel / image files to a conversation, with the heavy work
(extraction, parsing, OCR) done in the background so chat never waits.

**Backend** (commits 19547af, 3b49702, 7d8141e, 974be59, 952415e)
- `files` entity (`File`): owner + conversation FKs (CASCADE), original name,
  resolved MIME, size, storage key, status, extracted text, safe error message,
  attempts, timestamps. Indexes `(conversation_id, status)` and `(status, updated_at)`.
- Status machine `UPLOADING → PROCESSING → READY|FAILED`, plus `READY|FAILED →
  PROCESSING` for an explicit admin reprocess only; `assertTransition()` throws on
  anything else, and the worker claims a row with a conditional `UPDATE … WHERE
  status IN ('UPLOADING','PROCESSING')` so the claim is atomic.
- `FileStorageService` over MinIO. Keys are always `files/{userId}/{conversationId}/
  {uuid}.{ext}` — server-generated, the filename is never a path. The bucket is
  created idempotently at startup and a missing MinIO does not stop the API booting.
- Hand-rolled content detection (no detector dependency): `%PDF-`, PNG, JPEG, OLE2
  (with a `Workbook`/`Book` UTF-16 stream marker so `.doc` is rejected) and OOXML
  zip. The declared MIME, the content signature and the extension must all agree.
- `FilesService.upload`: validate → store → insert row (`UPLOADING`) → enqueue →
  respond. A failed insert deletes the stored object; a failed enqueue leaves the
  row `UPLOADING` for the sweeper and still returns 201.
- BullMQ queue `file-processing`, payload `{fileId}` (no binary in Redis), `jobId =
  fileId`, 3 attempts, exponential backoff, timeouts bounded by
  `FILE_PROCESSING_TIMEOUT_MS`, `concurrency: 2`.
- `FileProcessingService` (transport-free, unit-tested) + thin `FileProcessor`
  consumer: idempotent skip of terminal rows, permanent-vs-transient error classes
  (`PermanentExtractionError`), READY written together with the text, safe Persian
  reason on FAILED, and a 60 s orphan sweeper that re-enqueues lost jobs and fails
  rows that already burned their attempts.
- Extraction: pdf-parse (page-labeled text; empty text layer = explicit failure),
  SheetJS (per-sheet `Name | Age | City` tables, empty/malformed handling), and
  tesseract.js OCR (real OCR, language data cached outside the repo, air-gapped via
  `OCR_DATA_PATH`).
- Endpoints: upload / conversation file list / single-file status (owner-only, 404
  for foreign ids) and, for admins, a global list with counts, `/stats` with live
  queue depth, and reprocess.

**Chat integration**
- `POST /conversations/:id/messages` accepts `fileIds` (≤ 5, uuids).
  `getReadyContext()` resolves them **inside the conversation** and rejects
  anything not `READY` — a `PROCESSING` file answers «این فایل هنوز در حال پردازش
  است…», a `FAILED` file explains itself, and a foreign/unknown id is a single 400
  that never confirms existence.
- `buildContextualPrompt()` wraps the extracted text in explicit delimiters and
  splits `FILE_MAX_CONTEXT_CHARS` evenly across attachments, annotating truncated
  files instead of silently cutting them. With no attachments the prompt is
  byte-identical to the pre-feature path.
- `messages.attached_file_ids` (jsonb) persists the chips so a reload restores them.

**Frontend** (commit 92d5d26, admin view 42d98de)
- `FileChip.vue` (kind icon + name + size + spinner/check/cross status) reused by
  the composer and by sent messages; the composer's attach button is now functional
  (multi-select, client-side pre-checks, removable chips before send).
- ChatView uploads immediately on selection (so `UPLOADING` is real, not a client
  illusion), polls `GET /files/:id` while any attachment is not terminal, and
  restores chips + statuses from `GET /conversations/:id/files` after a refresh.
- `AdminFilesView.vue` + `FileTable.vue`: status filter, counts, queue depth,
  user/conversation context, safe error text, reprocess action.

**Issues found & fixed during verification**
- `file-type` and `@nestjs/bullmq` are ESM-only and unusable from Jest's CJS
  transform. Replaced the first with in-house signature detection and split the
  second behind a `FileJobQueue` port so the processing logic is transport-free.
- SheetJS parses arbitrary text as CSV, so a mislabeled text file "extracted"
  successfully. Added a container-format guard before parsing.
- **Real bug found by the E2E script:** reprocessing a file set the row to
  `PROCESSING` while BullMQ silently dropped the job (its `jobId` matched a
  still-retained terminal job), leaving the file stuck forever and invisible to the
  sweeper. The enqueue now clears a terminal job first and keeps the jobId dedupe
  for live jobs (commit 952415e).

**Verification**
- backend jest 162/162, `tsc --noEmit` clean
- `scripts/file-processing-test.mjs` 43/43 (upload → READY for all three kinds,
  corrupt → FAILED, validation, cross-user + cross-conversation denial, admin view,
  reprocess, refresh recovery, chat while PROCESSING — verified against a local echo
  provider so the streamed answer proves the extracted text reached the model)
- `scripts/smoke-test.mjs` 75/75 (Day 1–4 regression, green after the feature)
- `vue-tsc --noEmit` clean; frontend production build clean

**Decisions**
- Worker in-process with the API, not a separate deployment — no new service to run
  for a one-week MVP; the sweeper makes a crash recoverable.
- Object store for the binary + Postgres for metadata (never the other way round).
- Polling instead of WebSocket for file status: the chat already has SSE, and adding
  a second push channel for a slow-moving status was not worth the surface.
- No download/preview endpoint: files are AI context, not attachments to fetch.
- Real OCR rather than a fake success path; if OCR cannot run, the file fails with a
  reason (verified in this environment before committing to the library).

## Stage 14 — File preview, downloads and multi-upload UX

Follow-up round on the Stage 13 feature, driven by a client request: pick several files at once,
keep typing during an upload (but not send), see images as images, and click any attachment
afterwards to open it over a dimmed/blurred page with a download option and a close ×.

**Backend**
- `GET /files/:fileId/content` — owner-only byte stream (404 for foreign files and for a row whose
  object is missing, 401 unauthenticated). `FileStorageService.getStream()` pipes the object
  without buffering it, images/PDF are `inline` and everything else (or `?download=1`) is an
  `attachment`, and the response carries `nosniff`, the validated MIME, the real size and an
  RFC 5987 `filename*` so Persian names survive. No storage key or bucket URL is ever exposed.
- `content-disposition.ts` + spec: the ASCII fallback is stripped of quotes, backslashes and
  control characters so a hostile filename cannot break the header open.

**Frontend**
- Multi-select attach with concurrent uploads; every file becomes a chip immediately, with an
  image thumbnail drawn from the local `File` (`URL.createObjectURL`, rekeyed onto the server id
  when the upload returns, revoked when the chip goes away).
- Pending files moved into their own **tray above** the input box (count, «حذف همه», hint line).
- Send is disabled exactly while an upload is in flight («تا پایان آپلود امکان ارسال نیست»);
  typing and adding more files stay enabled, and processing files never block sending.
- `FileViewerModal.vue`: blurred backdrop, image or embedded PDF, kind badge, size, download
  button and a danger × close (Esc + click-outside too, body scroll locked, focus restored).
  Thumbnails for files restored from the server are fetched lazily through the content API.
- Fixed a latent RTL bug found while reviewing the screenshot: the attachment row inherited
  `dir="auto"` from the message body, so a Latin filename flipped the chips to LTR (wrong order,
  wrong edge). The row is now explicitly RTL.

**Verification**
- backend jest 169/169, `tsc --noEmit` clean
- `scripts/file-processing-test.mjs` 51/51 (8 new content checks: owner bytes, inline/attachment
  disposition, `nosniff`, no key leak, foreign 404, anonymous 401)
- `scripts/smoke-test.mjs` 75/75 (Day 1–4 regression unchanged)
- Frontend verified in the real app through the browser preview, not by reading code: two files
  injected through the hidden picker produced two chips; during a 3.7 MB upload the Send button
  was `disabled` with the explanation label and the tray read «در حال آپلود ۱ فایل»; after the
  upload it re-enabled while a file was still processing; the sent message kept both chips with
  the image thumbnail; clicking the image chip opened the viewer (blur visible in the screenshot,
  `blob:` document loaded with HTTP 200, no console errors), Esc and the × both closed it and
  released the scroll lock; a reload restored the chips and re-fetched the thumbnail; the mock
  model's answer quoted the OCR text («HELLO») and the PDF sentence, proving the context path.
  `vue-tsc --noEmit` clean; production build clean.

**Decisions**
- Bytes are proxied through the API rather than presigned URLs (ownership stays in one place,
  MinIO stays private).
- The viewer only opens for `READY` files; anything else answers with a toast instead of an
  empty frame.
- Non-renderable types (Excel) get the download path with an explanation — no Office renderer.
- The attach button stays enabled during an upload (uploads are independent); only Send is
  gated, because only Send can lose data.

## Stage 15 — Composer feedback round (files inside the input, file-only sends)

Client feedback on the Stage 14 UI: stop repeating the allowed types and the size cap, stop
printing the word «پیوست», put the chips inside the chat input rather than in a separate tray,
and let a chosen file be sent on its own — with the send button locked only while a file is
actually loading.

**Changes**
- The `PDF / Excel / تصویر — حداکثر ۱۰ مگابایت` hint is gone from the composer; the allowed
  types and size cap are enforced by the backend, which answers with a clear Persian error.
- The attachment tray (title, count badge, «حذف همه», explanatory lines) is gone. Files now
  render in a row **inside** the composer box with a hairline separator and per-chip ×; the
  only added line is the upload notice («در حال آپلود فایل… تا پایان آپلود امکان ارسال نیست»).
- Words containing «پیوست» were removed from the visible UI (the chip's clear button now says
  «حذف فایل»). Remaining uses are accessible/aria names only, plus the backend's own error copy.
- **File-only send:** the button unlocks as soon as the draft is non-empty *or* a `READY` file is
  present. With an empty draft the UI sends a neutral instruction («این فایل را بررسی کن.» /
  «این فایل‌ها را بررسی کن.») rather than relaxing the backend's non-blank content rule, so
  history and the auto-generated title stay meaningful.

**Real bugs found while verifying in the browser**
- **The model selector never worked.** `ModelSelector` emits `select`, but both call sites
  (`ChatHeader`, `MessageComposer`) listened for `update:model-id`, so choosing a model silently
  did nothing — in the header and in the composer. Fixed both bindings and confirmed the pill and
  the header now follow the selection. (Stage 10 shipped the feature with API tests only; the UI
  wiring had never been exercised in a browser.)
- **Retrying a failed answer dropped its files.** `retry()` re-sent the user row without
  `fileIds`, and the `send()` fallback looked at the composer's pending files (empty by then), so
  a retry asked the model about nothing. It now resends the row's own `attachedFileIds`.

**Verification (browser, not code reading)**
- Two files injected through the hidden picker rendered as chips **inside** the composer box
  (`box.contains(filesRow) === true`), one with a live image thumbnail, while the box showed
  «در حال آپلود…» and the send button was disabled with `aria-label="تا پایان آپلود امکان ارسال نیست"`.
- After the upload, Send was enabled with an **empty draft**; clicking it produced the user turn
  «این فایل‌ها را بررسی کن.» with both chips (thumbnail included) and persisted them.
- No visible occurrence of «۱۰ مگابایت» or «پیوست» remains in the composer (the only match on
  the page was the model's own earlier answer text).
- Model switch verified: selecting `gpt` in the composer moved both the pill and the header pill
  to `gpt`; a retry afterwards streamed a mock answer.
- Retry-with-files verified at runtime by capturing the request body: it contained
  `fileIds: [<2 ids>]` with the original `clientMessageId` (replay), where it previously carried
  no files at all.
- `vue-tsc --noEmit` clean; production build clean. Backend untouched this round (169/169 still
  green from Stage 14; the file E2E and Day 1–4 regression are unaffected by UI-only edits).

## Stage 16 — Chip density, the six-file cap and a filename-decoding fix

Second UI feedback round on the same flow: chips were too wide (three per line, with their
status words like «آماده» / «در حال آپلود» eating the row), nothing capped how many files could
be attached, and the send button had to stay locked until every chosen file finishes uploading
while typing stays possible.

**Changes**
- A chip is now icon + name + icon-only status + × (~125 px): the status words moved into the
  tooltip and the accessible name, the name cap dropped to 4.2rem, the thumbnail to 1.3rem, and
  `flex: 0 0 auto` makes chips wrap at their natural width instead of being crushed in a narrow
  panel. Five chips fit one row at `--chat-measure` (736px).
- Composer buttons shrank (2.3rem → 2.15rem) and the upload notice line is gone — the spinner on
  each chip is the progress, and the disabled send button explains itself through its title.
- Six-file ceiling per message: `DEFAULT_MAX_FILES_PER_MESSAGE` is shared by the DTO and the
  service, `FILE_MAX_PER_MESSAGE=6`, and the picker trims a batch to the remaining slots with a
  Persian toast so the limit is felt before the server has to reject anything.
- Send stays locked until every picked file finishes uploading while the textarea stays editable;
  a merely *processing* file still never blocks the message.

**Real bug found while verifying in the browser (not by reading code)**
- **Persian filenames were stored as mojibake.** Multipart names travel as raw bytes and busboy
  (behind multer) decodes them as latin1, so `عکس-نمونه.png` became `Ø¹Ú©Ø³-Ù†Ù…ÙˆÙ†Ù‡.png` — in the
  database, in the chip and in the download header. Added `decodeUploadFilename` at the
  controller boundary (re-reads the same bytes as UTF-8, leaves ASCII and genuinely latin1 names
  untouched) with unit tests, plus two E2E checks that a Persian name survives upload, storage
  and `Content-Disposition`.

**Verification**
- Backend: 174/174 unit tests; file E2E 53/53 (including the two new name checks); Day 1–4 smoke
  75/75 with the default model restored to `hoshyar` afterwards.
- Browser: a six-file batch rendered one row of 5 + 1 at the real composer width (3 + 3 in the
  narrow preview pane), no status words anywhere in the row, draft typed while a transfer ran,
  `SEND-LOCKED` sampled during the upload and open afterwards, an over-cap batch trimmed to six
  with «حداکثر ۶ فایل…», a file-only send that produced its message with chips, an image chip with
  a live thumbnail, and a viewer opening with `backdrop-filter: blur(10px)` plus a working
  download. Persian names round-tripped correctly once the fix was live.

## Stage 17 — Sequential uploads with per-file state and retry

Third pass on the same composer flow, this time on the *transfer* itself: a multi-file pick had to
become a sequence the user can read (one file uploading at a time, in pick order, each getting its
own ✓ the moment it lands) instead of a parallel burst the UI could not narrate — and a failure
had to stop the batch rather than silently continue the rest.

**Changes**
- New `frontend/src/utils/uploadQueue.ts`: a framework-free sequential queue that owns ordering and
  the halt-on-failure rule, hands a failed item back to the caller, and remembers the ids it already
  uploaded so nothing is ever transferred twice. Its behaviour is covered by
  `frontend/tests/uploadQueue.test.mjs` (7 checks), which runs the TypeScript module directly through
  Node's type stripping since the frontend has no test runner.
- `api/types.ts` gains `FileUploadState` (`pending | uploading | completed | error`) and
  `ComposerFile` (the server record plus local upload bookkeeping and the picked `File`, kept so a
  failed upload can be retried without re-selecting anything). The composer's files are now typed as
  `ComposerFile[]`, so `upload` and the server `status` stay visibly separate: a chip is `completed`
  (✓) as soon as the POST returns, even while the backend is still extracting text.
- `FileChip` renders the four states through one glyph (clock / spinner / check / cross) plus a small
  retry glyph that appears only on a failed upload, and takes an explicit `upload` prop — history
  chips keep deriving their state from the server status alone.
- `MessageComposer` locks Send while any file is `pending`, `uploading` or `error` — a written draft
  does not unlock it, and the button's tooltip/`aria-label` says why. The textarea is never disabled,
  so the draft is written and edited throughout and survives every state change.
- `ChatView` enqueues the picked batch (chips appear immediately, muted and dashed while queued),
  patches one chip at a time, and only polls the server for chips whose upload already returned.

**Real bug found while verifying in the browser**
- `refreshAttachments` replaced each chip object with the freshly polled server file, which dropped
  the local `upload` field and turned a settled `✓` back into an untyped status — the chips now merge
  the server fields into the existing chip so the upload state survives every poll. (Caught by
  `vue-tsc` first, confirmed fixed by re-running the batch.)

**Verification**
- Frontend: `vue-tsc` and the production build are clean; the 7 queue checks pass.
- Browser (live stack, real preview): a three-file batch walked `pending, pending, pending` →
  `✓, uploading, pending` → `✓, ✓, uploading` → all `✓`, with captured request intervals proving the
  transfers never overlapped and matched the pick order; Send was disabled in every non-terminal
  state while a draft typed mid-upload kept its text; a forced 500 on the second file left it `✗`
  with a retry and the third `pending` with no request issued, and the retry sent that file first and
  the third only after it succeeded; a single file behaved like a one-item batch; a reload restored
  every chip and status, and the console stayed free of Vue warnings.
