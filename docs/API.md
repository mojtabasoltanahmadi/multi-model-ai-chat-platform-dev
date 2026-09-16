# API Reference

Base URL: `http://localhost:4000/api` (through the Vite dev proxy: `/api` on port 5200).

All routes require `Authorization: Bearer <token>` **except** the two marked public.
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

`POST /conversations/:conversationId/messages` — body `{ content, modelId?, clientMessageId? }`

- `content` must be non-blank, ≤ 4000 chars (validated at the boundary)
- `modelId` optional; must reference a model that is **active** (and **free** for FREE-plan
  callers) — otherwise the default model is used. Authorization is re-checked on every send
  against current backend state; the frontend is never trusted (403 for a premium model
  requested by a FREE user, even via direct API calls).
- `clientMessageId` optional; opaque client-generated token (≤ 64 chars) used for idempotency.
  The same value may also be sent as the `Idempotency-Key` HTTP header — both are accepted,
  the header is just a convenience for proxies and replay logs.
- `fileIds` optional; up to 5 **`READY`** files **of this conversation** whose extracted text is
  added to the prompt. Any id that is unknown, belongs to another conversation/user, or is not
  `READY` rejects the send with 400 (before the stream starts). See
  [FILES.md](FILES.md#chat-integration).

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
  createdAt: string;             // ISO
}
```

## Files

| Method | Path | Notes |
|---|---|---|
| POST | `/conversations/:conversationId/files` | `multipart/form-data`, field `file`. **201** with the safe file shape. Foreign conversation → 404; empty/unsupported/mismatched content → 400; over the size limit → 413. Extraction never happens in this request. |
| GET | `/conversations/:conversationId/files` | files of one conversation, oldest first (used to restore statuses after a refresh) |
| GET | `/files/:fileId` | one file — the polling endpoint; foreign file → 404 |
| GET | `/files/:fileId/content` | owner-only bytes used for thumbnails, the preview viewer and downloads. Images/PDF are `Content-Disposition: inline` (plus `X-Content-Type-Options: nosniff`); everything else, or `?download=1`, is an `attachment`. Foreign file → 404, missing object → 404, no token → 401. |
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

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/models` | all models; `apiKey` never returned, `hasApiKey` instead |
| POST | `/admin/models` | `{ name, provider: 'mock'\|'openai-compatible', externalModelId, baseUrl?, apiKey?, isActive?, isFree? }`; the first active+free model auto-becomes default |
| PATCH | `/admin/models/:modelId` | partial update (incl. `isFree`); deactivating the default is refused (400); removing free access from the default is refused (400) |
| POST | `/admin/models/:modelId/default` | transactional swap; exactly one default; inactive or non-free models refused (400) |
| DELETE | `/admin/models/:modelId` | default model deletion refused (400) |

## Error semantics

| Status | Meaning |
|---|---|
| 400 | validation failure (empty/long message, bad UUID, inactive model, default-model rule incl. free access, idempotency content collision, file content/MIME/extension mismatch, attached file not `READY` or foreign, illegal file status transition, reprocess of a non-terminal file) |
| 401 | missing/invalid/expired JWT |
| 403 | authenticated but insufficient role — or a model the caller's plan is not allowed to use |
| 404 | unknown or foreign resource (no existence leak) |
| 409 | duplicate email on register |
| 413 | uploaded file exceeds `FILE_MAX_SIZE_BYTES` (rejected by multer before the handler runs) |
| 500 | unexpected error (clean JSON, details only in server logs) |
