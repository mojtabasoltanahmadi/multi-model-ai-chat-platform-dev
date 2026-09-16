# Architecture

A **modular monolith**: one NestJS application where each folder owns one domain.
No microservices, queues, or external infrastructure beyond PostgreSQL.

```
backend/src/
├── auth/            register, login, JWT issuing, admin seeding
├── users/           user entity + lookup service
├── conversations/   conversation entity, CRUD-lite, ownership lookup
├── messages/        message entity, chat-turn orchestration, SSE controller
├── models/          AiModel entity, admin management, chat model resolution
├── ai/              provider abstraction (mock + openai-compatible)
├── common/          guards, decorators, global exception filter
├── config/          typed env configuration
└── database/        TypeORM root module
```

## Data model

```
users(id, email UNIQUE, password_hash, role)          role ∈ {user, admin}
conversations(id, user_id → users, title, timestamps)  one owner per conversation
messages(id, conversation_id → conversations, role,    role ∈ {user, assistant}
         content, status, error_message, model_id,     status ∈ {pending, streaming,
         client_message_id, timestamps)                completed, interrupted, failed} |
                                                      null for user messages
ai_models(id, name, provider, external_model_id,       provider ∈ {mock, openai-compatible}
          base_url, api_key, is_active, is_free, is_default)
```

Foreign keys use `ON DELETE CASCADE` from messages→conversations→users, and
`SET NULL` for message→model (history survives model deletion). The
`client_message_id` column is indexed by `(conversation_id, role, client_message_id)`
for idempotency lookup; the same token is allowed across conversations (no global
unique constraint).

## Request flow for a chat turn

```
POST /api/conversations/:id/messages
  (JWT, JSON {content, modelId?, clientMessageId?},
   Idempotency-Key header mirrored from clientMessageId if present)
  │ ValidationPipe: boundary validation (non-blank, ≤ 4000 chars, UUIDs)
  │ JwtAuthGuard: authenticated user attached to request
  ▼
MessagesController
  │ 1. assertChatTurnAllowed: conversation owned by caller + model resolvable
  │    + idempotency lookup (replay or content-collision 400) — all 4xx-class
  │    errors happen HERE, BEFORE the SSE headers flush
  │ 2. flush SSE headers (200 text/event-stream)
  │ 3. persist user message (with client_message_id)
  │ 4. pre-persist assistant row with status='pending'
  │ 5. SSE: meta → delta* → done | error        (one logical assistant message)
  ▼
AiProviderService.streamChat(history, model)
     mock:                word-chunked canned Persian answer
     openai-compatible:   POST /chat/completions stream, parsed SSE → deltas
     timeout:             AbortController (AI_REQUEST_TIMEOUT_MS, default 60s)
```

### Streaming invariant (one message per turn)

An assistant row is created once per turn — **before** the first SSE byte — and
mutated in memory while streaming. Only terminal transitions hit the database:

- success → saved with `status='completed'`, full content
- provider error/timeout → saved with `status='failed'`, partial content, internal
  `error_message` (server-side only); client gets a generic error event
- client disconnect (before any delta OR after some deltas) → saved with
  `status='interrupted'`, partial content kept; **no error event** is emitted
  because the disconnector cannot receive it

Whatever the outcome, exactly one assistant row is persisted. The UI surfaces
`failed` and `interrupted` rows as Retry targets; see
[CONVERSATION_RESILIENCE.md](CONVERSATION_RESILIENCE.md) for the full state
machine and the disconnect-vs-failure disambiguation logic.

## Free-model access & plan authorization

The MVP has a single FREE plan (`UserPlan = 'free'`), but the authorization chokepoint is
already plan-aware. Access to a model = **active AND allowed for the caller's plan**
(`isFree = true` for the FREE plan). `isFree` and `isActive` are independent: a model can
be free-configured but temporarily disabled (hidden from the picker, not usable).

- `GET /models` returns only models the **caller's plan** may use — never the full catalog.
  Hiding models in the frontend is UX, not authorization.
- `ModelsService.resolveChatModel(modelId?, plan)` is the single chokepoint for chat:
  the requested (or default) model must exist (404), be active (400), and be allowed for
  the plan (403). It re-reads current backend state on **every send**, so a model disabled
  or un-freed after the user selected it is rejected on the next message — a stale frontend
  selector or direct API tampering cannot bypass it (concurrent admin changes are honored).
- The default model must always be **active + free**: `setDefault` refuses inactive or
  non-free models; deactivating/un-freeing/deleting the default is refused; the bootstrap
  auto-default only picks an active+free model. Free users therefore always have a valid
  default to fall back on.

## Model switching & per-message attribution

The model is stored **per assistant message** (`messages.model_id`), not per conversation.
Switching models mid-conversation only affects new turns; history is never rewritten.
Each assistant message remains attributable to the model that produced it (the SSE `meta`
and `done` events include `modelId`; the FK is `SET NULL` if the model is later deleted,
which preserves history).

## Security model

- **Secure by default**: `JwtAuthGuard` and `RolesGuard` are global. Routes opt OUT with
  `@Public()` (register/login) or declare `@Roles('admin')` (admin endpoints). Everything
  else requires a valid JWT.
- **Ownership in the query**: conversations and messages are looked up with
  `WHERE user_id = :caller` — foreign resources return 404, not 403, so existence is
  not leaked.
- **Passwords**: bcrypt (10 rounds). Login errors are identical for unknown email and
  wrong password.
- **Secrets**: provider API keys never leave the backend (responses carry `hasApiKey`).
  The admin list strips `apiKey`.
- **Provider failures**: caught in the chat turn; logged server-side; client sees
  «سرویس هوش مصنوعی موقتاً در دسترس نیست». Unhandled exceptions reach a global filter
  that returns clean JSON (no stack traces).

## Default-model invariant

At most one default model exists and it must be **active and free**:

- `setDefault` swaps in a transaction (clear all → set one); inactive or non-free models
  are refused (400).
- Creating the first active+free model auto-assigns default (bootstrap convenience).
- Deactivating, un-freeing, or deleting the default is refused (400) until another model
  is default.
- Chat falls back to the default only if it exists, is active, and is allowed for the
  caller's plan; inactive, unknown, or unauthorized model ids are rejected before any
  message is persisted.

## Resilience & recovery

A chat conversation is the user's unit of value — refresh, tab close, network
drop, multi-tab, or provider failure must all leave the user with a usable
conversation on their next visit. The full spec lives in
[CONVERSATION_RESILIENCE.md](CONVERSATION_RESILIENCE.md); the architectural
seams it relies on:

- **PostgreSQL is the source of truth.** Every bubble on screen was either
  just emitted by the server or read back from `GET /conversations/:id`.
  There is no purely-client "draft" row that can drift.
- **Pre-persist invariant.** `assertChatTurnAllowed` runs all 4xx checks
  before SSE headers flush. A successful request always leaves at least one
  DB row per user message, even if the AI fails to start.
- **Status state machine.** Assistant rows move through `pending → streaming
  → completed | interrupted | failed`. `pending` is persisted (not just
  in-memory) so a reload between POST and first delta still finds the row.
  `streaming` is in-memory only; only terminal transitions hit the DB.
- **Disconnect vs failure.** The server disambiguates an `AbortError` by
  asking `isClientDisconnected()` first. Client-initiated aborts
  (network drop, tab close, Stop button) become `interrupted`; genuine
  provider failures become `failed`. See
  [CONVERSATION_RESILIENCE.md §5](CONVERSATION_RESILIENCE.md#5-disconnect-vs-failure-disambiguation).
- **Idempotency.** A `clientMessageId` on the body (or as the
  `Idempotency-Key` HTTP header) makes the POST safely retryable. Reused
  ids with matching content produce a replay (same user row, new assistant
  row); mismatched content is rejected with 400 in pre-flight.

## Deliberate MVP trade-offs

- `synchronize: true` schema management (documented dev convenience; production would use migrations).
- No refresh tokens; token expiry is 1 day.
- API keys stored unencrypted in the database.
- No rate limiting / observability / queues — no requirement yet.
