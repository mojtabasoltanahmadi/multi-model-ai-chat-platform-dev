# Pre-Development Design — Task 1 (Days 1–2): AI Chat MVP

> Status: approved plan for the first 2-day task. This document is written **before
> implementation**; it removes ambiguity and defines what "done" means.
> As-built state is documented separately in [ARCHITECTURE.md](ARCHITECTURE.md) and
> [API.md](API.md). Assumptions are labeled `[A-n]`; open questions `[Q-n]`.

## Domain Glossary (used consistently below)

| Term | Meaning |
|---|---|
| **User** | A registered account (email + password). |
| **Admin** | A User with the `admin` role; manages AI Models. |
| **Conversation** | An owned thread of messages. |
| **Message** | One chat entry; role `user` or `assistant`. |
| **Turn** | One user message + its single logical assistant reply. |
| **AI Model** | A configured model entry (name, provider, credentials, active flag). |
| **Provider** | External AI service (OpenAI-compatible endpoint, or a built-in mock). |
| **Default Model** | The single active model used when the user picks none. |
| **Streaming** | Server pushes answer chunks to the client as they are produced. |

---

## 1. Problem & Goal

**Problem.** Persian-speaking users have no AI chat product that treats Persian as a
first-class citizen (RTL layout, Persian typography and UX copy). The company must also
be able to demo a working product to test users within days, without committing to one
AI vendor.

**MVP goal (Days 1–2).** A running, test-user-demoable platform where a user can
register, log in, hold a text conversation, watch the AI answer **stream in live**, and
an admin can manage AI models and set the default — all built on a clean, extendable
codebase (NestJS + Vue 3 + Vite + PostgreSQL/TypeORM) that later 2-day tasks can grow
without rewrites.

**Non-goal.** Production infrastructure. The brief explicitly excludes Kubernetes,
clusters, and complex ops from this phase.

## 2. Actors & User Stories

**Actors:** Visitor (unauthenticated), User (test user), Admin, AI Provider (external
system), Backend (system actor that enforces rules).

| ID | As a… | I want… | so that… |
|---|---|---|---|
| US-1 | Visitor | register with email + password | I get an account |
| US-2 | Visitor | log in | I reach my own chat workspace |
| US-3 | User | start a conversation and send a text message | I can ask the AI something |
| US-4 | User | see the answer appear progressively as it is generated | I perceive the product as fast and alive |
| US-5 | User | reopen a past conversation | my history is preserved |
| US-6 | User | get a clear message when the AI service fails | I know it's temporary and can retry |
| US-7 | Admin | list, create, activate/deactivate models | I control what users can chat with |
| US-8 | Admin | set the default model | new chats use the model I choose |
| US-9 | User | only see my own conversations | my data stays private |

## 3. Functional Requirements

* FR-1 **Registration**: create an account with a valid, unique email and a password of
  ≥ 8 characters; duplicate email → clear error; password never stored or returned in
  plain text.
* FR-2 **Login**: valid credentials return an auth token + user profile; invalid
  credentials → a single generic rejection (no indication whether email exists).
* FR-3 **Protected access**: every API except register/login requires a valid,
  unexpired token; invalid/expired tokens are rejected.
* FR-4 **Conversations**: an authenticated user can create, list (own only), and open a
  conversation with its message history.
* FR-5 **Message sending**: content must be non-blank after trim and ≤ 4000 characters
  `[A-4]`; conversation must exist and belong to the sender.
* FR-6 **AI reply**: each turn produces exactly one assistant answer using the selected
  model, or the Default Model when none is selected.
* FR-7 **Streaming**: the answer is delivered to the client as successive text chunks
  as the provider produces them; the UI renders chunks progressively; the final answer
  persists and remains visible without a page refresh.
* FR-8 **Failure states**: AI timeout/error/disconnect surfaces a generic, actionable
  user-facing message; the failed/partial turn is recorded distinctly.
* FR-9 **Admin model management**: admin-only endpoints to list, create,
  activate/deactivate, and delete models; a normal user is refused (403).
* FR-10 **Default model**: admin can change the default at runtime (no code change or
  redeploy); the system refuses to end up without exactly one valid default.
* FR-11 **Model visibility**: users can chat only via **active** models; inactive or
  unknown model ids are rejected before any message is sent to the provider.

## 4. User Flow

**Happy path (chat):**
1. Visitor opens the app → register (or login).
2. Lands on an empty chat workspace with a branded welcome state.
3. Types a message and sends → conversation is created implicitly if none active `[A-6]`,
   user message appears immediately.
4. A streaming placeholder appears; chunks arrive and render progressively.
5. Stream completes → the final assistant message replaces the placeholder; history is
   persisted; the sidebar shows/updates the conversation (auto-titled from the first
   message `[A-7]`).
6. User can start another conversation, switch between conversations, or log out.

**Alternative flows:**
- **Invalid input** (blank/oversized message) → inline/boundary error; nothing sent.
- **Bad credentials / expired session** → error message; redirect to login; protected
  content never renders.
- **AI provider fails or times out mid-answer** → partial answer stays visible, marked
  as failed, with a generic "service temporarily unavailable" message and retry possible.
- **No default model configured** → chat send is refused with guidance to contact admin;
  admin panel is where it gets fixed.
- **User opens another user's conversation (by guessing an id)** → 404, indistinguishable
  from a nonexistent id.

## 5. Business Rules

* BR-1 Emails are normalized (trim + lowercase) before uniqueness check; uniqueness is
  enforced in the database.
* BR-2 Passwords: ≥ 8 chars `[A-4]`, stored only as salted hashes (bcrypt).
* BR-3 A Conversation always belongs to exactly one User; a Message always belongs to
  exactly one Conversation; neither can be created without a valid owner.
* BR-4 Message content: required, non-blank after trim, ≤ 4000 chars `[A-4]`.
* BR-5 Only active models can be selected for a new turn; the Default Model must be
  active; changing the default is atomic (clear-all + set-one).
* BR-6 The default model cannot be deactivated or deleted until another model is made
  default first.
* BR-7 The first active model created becomes the default automatically (bootstrap
  convenience) `[A-5]`.
* BR-8 One turn = one logical assistant message, in every outcome (success, AI failure,
  client disconnect) — a status field distinguishes them.
* BR-9 Login failures for "unknown user" and "wrong password" are textually identical.
* BR-10 AI provider errors are logged server-side with detail; clients receive a generic
  message only (no provider names, hosts, or error codes).

## 6. Invariants

Conditions that must hold at all times — enforced by design, not by individual
handlers. (Validations check *input*; invariants protect *system truth*.)

* INV-1 Every conversation/message access path filters by the authenticated owner.
* INV-2 Password hashes only — plain passwords never persist anywhere.
* INV-3 At most one Default Model exists, and it is active.
* INV-4 An inactive model can never be used for a new chat turn.
* INV-5 Exactly one assistant message row exists per turn, regardless of stream outcome.
* INV-6 An AI provider failure never crashes the backend process or a request without a
  clean JSON/SSE error.
* INV-7 All external input is validated at the system boundary (DTO layer) before any
  business logic runs.
* INV-8 Admin-scoped operations are unreachable for non-admin principals.
* INV-9 Client-issued ids are never trusted (ownership resolved server-side).
* INV-10 A later feature may not break an earlier one (regression suites keep passing).

## 7. Edge Cases & Failure Scenarios

| Scenario | Expected behavior |
|---|---|
| Duplicate email registration | 409, friendly message, no data written |
| Malformed/short password, invalid email | 400 at the boundary, field-level feedback |
| Unknown user vs wrong password | identical 401 (no enumeration) |
| Missing / invalid / expired token | 401 on any protected route |
| Guessing another user's conversation id | 404 (not 403) — no existence leak |
| Empty or whitespace-only message | 400, never reaches the provider |
| > 4000-char message | 400 with limit guidance |
| Provider timeout | abort after configured timeout `[A-8]`, generic error, one `error`-status row |
| Provider connection drops mid-stream | partial content kept, marked distinguishably, backend stays healthy |
| Client disconnects mid-stream | server stops streaming, persists partial content with error status |
| No default model at send time | 400 with actionable guidance |
| Attempt to disable/delete the default model | 400, state unchanged |
| Attempt to set an inactive model as default | 400 |
| Concurrent "first model" creation | at most one default afterwards (documented risk if unsynchronized `[Q-4]`) |
| Very long conversation history | full history replayed to provider `[A-9]`; no truncation in MVP |

## 8. Data Model

Four entities — deliberately no more.

```
users ──< conversations ──< messages >── ai_models
```

* **users**: id (PK), email (UNIQUE), password_hash, role ('user' | 'admin'), created_at.
* **conversations**: id (PK), title, user_id (FK → users, ON DELETE CASCADE), created_at,
  updated_at. Index on user_id.
* **messages**: id (PK), conversation_id (FK → conversations, ON DELETE CASCADE),
  role ('user' | 'assistant'), content,
  status ('pending' | 'streaming' | 'completed' | 'interrupted' | 'failed' | NULL —
  NULL for user rows), error_message (internal only), model_id (FK → ai_models,
  ON DELETE SET NULL), client_message_id (idempotency token, indexed by
  (conversation_id, role, client_message_id)), created_at.
  Indexes on conversation_id, model_id.
* **ai_models**: id (PK), name, provider ('mock' | 'openai-compatible') `[A-2]`,
  external_model_id, base_url (nullable), api_key (nullable, never returned by any API),
  is_active, is_default, created_at.

Schema management: dev-mode auto-sync now; versioned migrations before any shared
deployment `[Q-2]`.

## 9. API Requirements

Endpoint *intents* only — the full contract (request/response shapes, status codes, SSE
event grammar) belongs to the API Contract document ([API.md](API.md) as-built).

| Area | Need |
|---|---|
| Auth | register; login → token + profile |
| Conversations | list own; create; get one with messages |
| Chat | send message → **streamed** answer (POST-based SSE `[A-3]`), carrying optional model id |
| Models (user) | list *active* models for the picker |
| Models (admin) | list all (secrets stripped); create; update (incl. activate/deactivate); set default; delete |

Cross-cutting: uniform error envelope; Persian user-facing messages; no provider
internals in any response; UUID params validated.

## 10. UI Requirements

Behavior-first; visuals follow DESIGN_SYSTEM.md.

* **Login / Register**: labeled fields, inline validation, submit loading state, error
  banner, password visibility toggle; link between the two.
* **Chat workspace**: sidebar (new conversation, search, list with active state,
  profile/logout) + main column (header with model indicator/selector, message list,
  composer).
* **Empty state**: branded welcome with actionable prompt starters.
* **Streaming display**: user message renders instantly; assistant answer grows
  chunk-by-chunk with a calm indicator; no page refresh ever needed; a stop control
  cancels generation.
* **States everywhere**: loading skeletons, empty states, inline errors, toast-style
  feedback for transient failures.
* **RTL-first**: layout, icons, dropdowns designed for Persian; Latin fragments
  (emails, model ids, code) isolated LTR.

## 11. Non-Functional Requirements

* **Security**: bcrypt password hashing; token-based auth with global guards
  (secure-by-default: routes opt *out*, not in); input whitelist validation; ORM
  parameterization (no string SQL); provider API keys never leave the backend.
* **Reliability**: provider failures isolated per-request; server survives provider
  outages; partial answers preserved, never silently dropped.
* **Performance (MVP-level)**: first streamed chunk perceived quickly; no pagination in
  v1 `[A-9]`; no premature caching/queues.
* **Maintainability**: modular monolith (one domain per module); TypeScript end-to-end;
  one shared design token system; docs updated per stage.
* **Testability**: business rules and security invariants covered by automated tests
  runnable without external services (mock provider).
* **Compatibility**: modern evergreen browsers; desktop + mobile responsive.

## 12. MVP Scope

**Must have** — registration, login/JWT, conversations + history, validated messaging,
real server-side streaming with progressive UI, one usable provider path, admin model
CRUD, default-model rule enforcement, error/empty/loading states, tests for rules +
security, run instructions.

**Should have** (if time allows) — user-facing model picker, auto-titling from first
message, markdown rendering of answers, copy-answer action, collapsible sidebar.

**Out of scope (Task 1)** — file upload, email verification, password reset, refresh
tokens, rate limiting `[Q-3]`, Redis/BullMQ, MinIO, OpenTelemetry/SigNoz, k6, RAG,
payments, multi-agent, Kubernetes, i18n beyond Persian, mobile apps.

## 13. Open Questions & Assumptions

**Contradictions/ambiguities identified in the brief:**
* C-1 The stack slide lists Redis+BullMQ / MinIO / OTel+SigNoz / k6, but the project
  rules say "only where genuinely needed" and the Day-1–2 output list includes none of
  them. **Resolution**: none of these are Task-1 scope; they enter only when a later
  task's requirement demands them.
* C-2 "گفتگوی متنی با یک مدل" (chat with one model) vs. a multi-model admin panel.
  **Resolution**: the *platform* is multi-model; MVP chat defaults to the Default Model;
  per-message model selection is "should have".

**Assumptions (decisions we will make unless the client objects):**
* A-1 Admin account is seeded from environment variables at startup (no admin
  self-promotion flow).
* A-2 Provider abstraction ships two adapters: a deterministic **mock** (demo + tests,
  no key needed) and an **openai-compatible** HTTP adapter (works with OpenAI and
  compatible vendors).
* A-3 Streaming uses Server-Sent Events over an authenticated POST (EventSource cannot
  send auth headers or bodies).
* A-4 Password minimum 8 chars; message maximum 4000 chars.
* A-5 First active model auto-becomes default so a fresh install can chat immediately.
* A-6 Sending the first message creates the conversation implicitly (no separate
  "create" step forced on the user).
* A-7 Conversation title defaults from the first message (truncated).
* A-8 Provider requests time out after 60s (configurable).
* A-9 Full conversation history is replayed as provider context; no summarization or
  truncation in v1.
* A-10 Access tokens live 24h; no refresh flow in v1.
* A-11 Test users self-register; there is no invite/allowlist.

**Open questions for the client:** Q-1 Which real provider + budget for the demo?
Q-2 Migration policy timing (before first shared deployment?). Q-3 Rate limiting on
auth endpoints — required for the test-user demo? Q-4 Is the tiny "concurrent first
model creation" race acceptable (DB-level unique default index as later hardening)?

## 14. Acceptance Criteria

* AC-1 Register→login→token works; duplicate email, invalid email, short password each
  rejected with the right status; DB stores hashes only (inspectable).
* AC-2 Without a token, and with an invalid/expired token, protected routes return 401.
* AC-3 User B cannot read or send into user A's conversation (404, both via API).
* AC-4 Non-admin calling any admin endpoint → 403; admin succeeds.
* AC-5 Sending a valid message yields: HTTP stream with progressive chunks (≥ 3 chunks
  observable before completion), exactly one persisted assistant row whose content
  equals the chunk concatenation, visible without refresh.
* AC-6 Blank/whitespace/oversized messages → 400, nothing persisted, nothing sent to
  the provider.
* AC-7 With the default inactive/unknown/absent: chat is refused (400/404) before any
  provider call; admin can fix it at runtime without redeploy.
* AC-8 Disabling or deleting the default model → 400 until another default is set;
  exactly one default exists after any admin sequence.
* AC-9 With a broken provider: generic user-facing error (no internals verifiable),
  backend stays up, exactly one `error`-status assistant row with partial content.
* AC-10 Regression suite (auth + chat + admin) passes after any later change.
* AC-11 A new developer can run backend + frontend + DB from README in one sitting.

## 15. Implementation Breakdown

Ordered for a 2-day window; each item is independently verifiable. (T-n = task.)

**Database / infra (½ day)**
* T-1 Repo scaffold, env config module, `.env.example`, Postgres connection, entities
  with FKs/indexes, dev schema sync. *Verify: app boots, tables exist.*

**Backend (1 day)**
* T-2 Auth: register/login DTOs, bcrypt, JWT issue, global guards, error envelope.
  *Verify: AC-1, AC-2.*
* T-3 Conversations + messages: ownership-in-query services, send endpoint with
  boundary validation. *Verify: AC-3, AC-6.*
* T-4 Provider abstraction (mock + openai-compatible) and SSE streaming turn with
  one-row invariant + failure paths + timeout. *Verify: AC-5, AC-9.*
* T-5 Models module: user list-active; admin CRUD + transactional default swap +
  protections; admin seed. *Verify: AC-4, AC-7, AC-8.*

**Frontend (1 day, overlaps backend after T-2)**
* T-6 API client + auth store + router guards. *Verify: AC-2 in UI.*
* T-7 Auth pages with validation/loading/error states.
* T-8 Chat workspace: sidebar, conversation switching, message list, composer, **SSE
  consumption with progressive rendering**, empty/loading/error states. *Verify: AC-5
  visually.*
* T-9 Admin models page wired to admin APIs. *Verify: AC-4, AC-8 in UI.*

**Testing & docs (½ day, woven in)**
* T-10 Unit tests for business rules/invariants (mocked repos); HTTP smoke suite
  covering all ACs end-to-end (mock provider). *Verify: AC-1…AC-10 automated.*
* T-11 README (setup/run/test) + stage documentation. *Verify: AC-11.*

Risk buffer: if time runs short, cut only "should have" items — never tests or
error states.
