# AI Chat MVP — پلتفرم چت چندمدلی

A minimal, working MVP of a multi-model AI chat platform for Persian-speaking users:
register/login, own conversations, streamed AI responses, admin-managed AI models, and
file attachments (PDF / Excel / image) processed asynchronously in the background.

- **Backend**: NestJS + TypeORM + PostgreSQL (modular monolith, port 4000)
- **Frontend**: Vue 3 + TypeScript + Vite (RTL Persian UI, port 5200, light & dark themes)
- **File storage**: MinIO (`chat-files` bucket) — the binary never enters PostgreSQL
- **Background work**: BullMQ over Redis (`file-processing` queue, worker in the backend process)

## Quick Start

### 1. Prerequisites

- Node.js 20+ (developed on Node 24)
- PostgreSQL 14+ (developed on PostgreSQL 18) — a local install or the compose service
- Redis + MinIO — both provided by `infra/docker-compose.yml` (needed for file uploads)

### 2. Infrastructure

Everything the backend needs (database, object storage, queue broker) runs from one compose file:

```bash
docker compose -f infra/docker-compose.yml up -d      # db (5433), redis (6379), minio (9000/9001)
```

Prefer a local PostgreSQL? Create the database instead and still start redis + minio:

```sql
CREATE DATABASE ai_chat_mvp;
```

### 3. Backend

```bash
cd backend
cp .env.example .env        # then edit DB_PASSWORD and JWT_SECRET
npm install
npm run start:dev           # http://localhost:4000/api
```

On first boot the backend creates the schema (`DB_SYNCHRONIZE=true`, dev convenience), creates the
MinIO bucket if needed, and seeds an admin account from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (defaults:
`admin@example.com` / `admin1234` — change them for any real deployment). When you use the compose
database rather than a local install, set `DB_PORT=5433` to match its published port.

### 4. Frontend

```bash
cd frontend
npm install
npm run dev                 # http://localhost:5200
```

The Vite dev server proxies `/api` to `http://localhost:4000`, so no CORS setup is needed.

### 5. First chat

1. Log in as the admin → open **پنل مدیریت مدل‌ها**.
2. Create a model. Four provider kinds exist (one adapter each):
   - `mock` — streams a canned Persian response, no API key needed (great for demos/tests)
   - `openai-compatible` — any OpenAI-compatible streaming API (set `externalModelId`, optional
     `baseUrl`, and `apiKey`)
   - `anthropic` — Claude via the native Messages API (`x-api-key` + `anthropic-version` headers)
   - `google` — Gemini via `streamGenerateContent` (`x-goog-api-key` header)
   Each model can also declare `capabilities` (currently `web-search`, `reasoning`) — metadata
   the chat picker shows as glyphs.
3. The first active model automatically becomes the default.
4. Register a normal user, create a conversation, and chat — responses stream in live.
5. Add files with the 📎 button — it accepts several at once (at most six per message), and they
   appear as compact chips inside the input box: a clock while queued, a spinner while
   uploading/processing, a check once uploaded, a cross on failure (with a retry on the chip
   itself), and a thumbnail for images. The tooltip carries the words (name, size, status). The
   batch is **uploaded one file at a time, in the order you picked them**, and you can send with a
   file alone (no text). Send unlocks only after every picked file has finished uploading — even
   with a draft written — while you keep typing the whole time and chat stays fully usable while a
   file is processing. If one file fails, nothing behind it starts until you retry or remove it.
6. Click a ready chip — on a sent message too — to open it: the image or PDF appears over a
   blurred backdrop with a download button and a close × (Esc works).

## Tests

```bash
cd backend
npx jest                             # 174 unit tests (no database or services needed)

# with the backend + postgres + redis + minio running:
node ../scripts/smoke-test.mjs       # 75 end-to-end HTTP checks (Day 1-4 regression)
node ../scripts/file-processing-test.mjs   # 53 file upload/processing/preview checks (Day 5-6)

cd frontend
node --experimental-strip-types tests/uploadQueue.test.mjs   # 7 composer upload-queue checks
```

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md) — pre-development design for Task 1 (requirements, rules, invariants, scope, breakdown)
- [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) — visual source of truth: tokens, components, page patterns, decision log
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules, data model, invariants, error handling
- [docs/API.md](docs/API.md) — endpoint reference and the SSE streaming protocol
- [docs/FILES.md](docs/FILES.md) — file upload, storage, queue/worker, extraction, limits, recovery
- [docs/STAGES.md](docs/STAGES.md) — implementation stages, decisions, edge cases, known limitations

## Security notes

- Passwords are stored as bcrypt hashes; JWTs are required on every route except
  `/auth/register`, `/auth/login`, the payment webhook (authenticated by an
  HMAC-SHA256 signature over the raw request body instead) and
  `GET /themes/available` (public: pre-login pages theme themselves; it exposes
  only enabled-theme display metadata). Secure by default, `@Public()` opt-out.
- Conversations/messages are filtered by owner in the query itself; other users' resources
  return 404 (no existence leak).
- Provider API keys are stored server-side and never returned by any API (`hasApiKey` flag only).
- AI provider failures surface as generic client-facing messages; details stay in server logs.
- AI markdown responses are rendered with raw HTML disabled (no script injection).
- Free-plan model access is enforced server-side: `GET /models` returns only active+free
  models, and every chat send re-verifies that the requested (or default) model is active
  and allowed for the caller's plan — hiding models in the UI is never the authorization
  mechanism (see docs/ARCHITECTURE.md → Free-model access & plan authorization).
- Billing authorization is equally server-side: plan prices and entitlements are resolved
  from the `plans`/`subscriptions` tables on every request (client-sent money values are
  ignored), webhook deliveries are HMAC-signed and idempotent, payment history is
  owner-scoped in the query, and the audit log has no update/delete path
  (see docs/architecture/day-9-10-billing.md).
- File ownership is enforced in the query on every read and upload (foreign files and
  conversations are 404, never 403), uploads are validated by content signature rather than by
  trusting the filename or the declared MIME, storage keys are server-generated
  (`files/{userId}/{conversationId}/{uuid}`), and MinIO credentials never leave the backend.
  An attached file must belong to the conversation being written to and be `READY` before its
  text can reach a prompt. Admin file endpoints are role-guarded server-side.

## Known limitations (deliberate MVP scope)

- Schema via `DB_SYNCHRONIZE` instead of migrations (dev-only convenience, see docs/STAGES.md)
- Access tokens only (no refresh tokens / logout blacklist)
- API keys stored in plain text in the database (masked at the API boundary)
- The file worker runs inside the backend process (a separate worker deployment is future work)
- OCR is CPU-bound and single-language (`OCR_LANGUAGE`, default `eng`); scanned PDFs are not
  OCR-ed (a PDF with no text layer fails rather than being rasterized)
- File bytes are proxied through the API (owner-checked) instead of presigned storage URLs, so
  previews and downloads stream via the backend
- The viewer shows images inline and embeds PDFs; other types download rather than render. No
  antivirus scanning, and no extracted-text view in the admin panel (admins see status, size,
  type and the safe error reason)
- File status updates are polled by the UI, not pushed
- No regenerate-message action (requires a backend regenerate endpoint)
- Payments use a built-in gateway simulator (correctly-signed events through the
  production webhook pipeline); no real provider integration, invoices, refunds or
  proration yet, and pending payments have no auto-expiry sweeper
- Subscription expiration is evaluated lazily on entitlement reads (no cron/scheduler)
- No rate limiting or observability stack — none are needed yet
