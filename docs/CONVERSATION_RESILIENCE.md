# Conversation Resilience

How chat turns survive refresh, tab close, internet disconnect, multiple tabs,
and provider failures — and how the UI brings each of them back.

Companion doc to [ARCHITECTURE.md](ARCHITECTURE.md) (system shape) and
[API.md](API.md) (HTTP/SSE contract). The Day 3+4 work in `STAGES.md` §11 was
authored against this spec.

---

## 1. Threat model

The conversation is the unit of value. Every event below MUST leave the user
with a usable conversation on their next visit:

| # | Event | Required outcome |
|---|---|---|
| 1 | User refreshes the browser mid-stream | Conversation reloads; the latest pending/streaming assistant row auto-attaches to the still-running generation via the reconnect stream and finishes streaming. No Retry click, no regenerated content. |
| 2 | User closes the tab mid-stream | The generation keeps running server-side and completes in the DB. Next visit: the completed answer is simply there. |
| 3 | User opens a second tab on the same conversation | Second tab joins the SAME live generation (snapshot + remaining deltas). It cannot duplicate the user's message, fabricate AI text, or start a second generation. |
| 4 | Internet drops mid-stream | The generation continues server-side. The client keeps the tokens already delivered, marks the row locally `interrupted` (a view hint, not a DB state), and when connectivity returns the row auto-re-attaches to the live generation and finishes. |
| 5 | Provider errors out (timeout, 5xx, refused connection) | Server persists the partial answer with `status='failed'` and an internal `errorMessage`. The client gets a generic, non-leaky message. Retry produces a fresh assistant row. |
| 6 | User hits Stop (abort) | This view detaches from the live stream; the generation still completes server-side and is persisted. The row renders locally as `interrupted`; a reload or reconnect shows the real (completed) state. |
| 7 | User double-clicks Send | The second click is rejected (`streaming.value === true` guard on the client). |
| 8 | Network blip causes the same POST to retry | Backend recognizes the idempotency key, reuses the user row, streams a fresh assistant. No duplicate user bubble. |
| 9 | Server restarts mid-generation | The in-memory generation is lost — no fake resume. The orphaned `pending`/`streaming` row is honestly marked `interrupted` on the next reconnect attempt and offered for retry. |

---

## 2. Persistence is the source of truth

PostgreSQL holds the entire conversation. The frontend NEVER invents a
message — every bubble on screen was either:

- just emitted by the server (live stream), or
- read back from `GET /conversations/:id` (refresh, retry, tab switch).

Implication: there is no purely-client "draft" or "placeholder" row that
can drift from the server. The streaming placeholder in the UI is a Vue
ref tagged with a sentinel id (`__streaming__`); it is replaced by the
real row as soon as the `meta` event lands and is purged entirely on
done/error.

---

## 3. Assistant message state machine

The `messages.status` column is a small enum on the assistant role:

```
       ┌──────────┐
       │ pending  │  pre-persisted, AI not started yet (DB row exists)
       └────┬─────┘
            │ first AI delta arrives (persisted immediately)
            ▼
       ┌──────────┐
       │ streaming│  AI is producing bytes (persisted; content flushed on a 1.5s throttle)
       └────┬─────┘
            │
   ┌────────┼─────────────────────┐
   ▼        ▼                     ▼
┌────────┐ ┌──────────┐    ┌──────────┐
│completed│ │interrupted│    │ failed   │
└────────┘ └──────────┘    └──────────┘
  success    orphaned by a     provider / network
             server restart,    failure (failed event
             or the user's      with generic message)
             view detached
```

`pending` is written **before** the SSE `meta` event is emitted — a reload
between the POST and the first delta still finds the row.

`streaming` is persisted on the first delta and the content is flushed on a
1.5s throttle (`AI_PERSIST_INTERVAL_MS`) — a crash loses at most ~one
interval of tokens. The live bytes in flight are the SSE deltas, not the DB.

**A client disconnect never writes `interrupted`.** Disconnect only removes
a subscriber; the generation always runs to `completed` or `failed`. The
`interrupted` status is reserved for genuinely unfinished generations:
orphaned rows after a server restart, and the local view hint when the user
detaches (Stop) or a transport drop severs a live feed.

`interrupted` vs `failed` is a meaningful distinction (see §5).

User rows always have `status = null`.

---

## 4. Idempotency

The client generates an opaque token (`cm-<base36 ts>-<rand>`, ≤ 64 chars)
and sends it in the body as `clientMessageId`, mirrored to the
`Idempotency-Key` HTTP header for proxies and replay logs.

The backend's contract:

| Case | Behavior |
|---|---|
| No `clientMessageId` provided | New user row, normal flow. |
| `clientMessageId` provided, no row matches in this conversation | New user row with `client_message_id = <token>`. |
| `clientMessageId` matches an existing user row, **content matches** | Reuse the user row; create a fresh assistant row; emit `replay: true` in `meta`. |
| `clientMessageId` matches an existing user row, **content differs** | `400 این پیام قبلاً با متن دیگری ارسال شده است.` (caught in pre-flight, before SSE headers open). |

The matching index is `(conversationId, role='user', clientMessageId)`.
Composite key on the column, not unique constraint — the same token is
allowed across conversations.

**Idempotency is the only mechanism that prevents double-send.** It is
intentionally simple: there is no Redis, no queue, no replay log. The
backend resolves the collision by looking at the conversation's own
message rows.

---

## 5. Disconnect vs failure disambiguation

The disambiguation is **architectural, not heuristic**: the generation loop is
detached from the HTTP response entirely (`GenerationRegistry`), so a client
disconnect never even reaches the loop. There is no `isClientDisconnected()`
branch to get wrong.

```
HTTP response ──client leaves──▶ connection ends (subscriber removed)
                                     │
                                     ▼  (loop is untouched)
     generation loop:  for-await delta from AI
                                     │
              ┌──────────────────────┴──────────────┐
              │ provider succeeds                   │ provider throws
              ▼                                     ▼
     status = 'completed'                  status = 'failed'
     emit done                             emit failed + generic message;
                                           raw detail in errorMessage
```

A client that disconnects and returns later re-enters through the reconnect
stream (`GET /conversations/:id/messages/:messageId/stream`): snapshot of the
content so far, then the remaining deltas, then the terminal event — from the
SAME generation, without re-invoking the AI. See [API.md](API.md) for the wire
contract.

The provider timeout's `AbortError` still lands in the failure branch above
(it is a provider failure, not a disconnect) and persists `failed`.

---

## 6. Pre-persist invariant

`MessagesController.sendMessage` calls `MessagesService.assertChatTurnAllowed`
**before** the SSE headers are flushed. This is the single chokepoint for
all 4xx-class errors:

- 401 (auth — handled by `JwtAuthGuard`)
- 404 unknown/foreign conversation
- 400 inactive model, bad UUID
- 403 model not allowed for the caller's plan
- 400 idempotency collision (same token, different content)

Only after the check passes do we:

1. Flush SSE headers (`200 OK`, `text/event-stream`).
2. Persist the user row.
3. Pre-persist the assistant row with `status='pending'`.
4. Emit the `meta` event (carrying the real `assistantMessage.id`).
5. Stream deltas.

This guarantees that a 4xx never produces an orphan SSE response, and a
successful request always leaves at least one DB row per user message
even if the AI fails to start.

---

## 7. Frontend UX mapping

| DB status | Component rendering | User affordance |
|---|---|---|
| `null` (user row) | Soft accent block, `dir="auto"` | none (read-only history) |
| `pending` / `streaming` (no live deltas — just recovered) | Muted in-progress text + animated dots (`aria-live="polite"`) | none — the reconnect stream auto-attaches |
| `streaming` (live deltas arriving on this tab) | Markdown rendered progressively + caret | Stop button (composer) |
| `completed` | Full markdown body | Copy |
| `interrupted` (after reload: orphaned by restart) | Italic muted partial content + note | **Retry** |
| `failed` | Red surface + fixed generic note (never the raw `errorMessage`) | **Retry** |

The Retry button is disabled while another send is in flight
(`streaming.value` is shared across the page). It calls
`send(userRow.content, { clientMessageId, existingUserRowId: userRow.id })`:
the user row stays on screen (no duplicate bubble) and the backend treats the
call as a replay. The raw persisted `errorMessage` is an internal ops detail
and is never rendered.

---

## 8. Last-opened conversation persistence

The active conversation id is stored in `localStorage` under
`hooshyar.active-conversation` (UUID-validated on read). On mount, the
chat view restores it — but only if it still belongs to the user. A
foreign or deleted id is silently cleared.

This is a UX nicety, not a security boundary. The JWT still gates every
request; the id is just a hint.

---

## 9. Offline banner

`useOnline()` is a singleton composable wrapping `navigator.onLine` and
the `online`/`offline` window events. The signal is a UI HINT — the
browser may report "online" while DNS / captive portals are broken — so
each request still surfaces its own error.

The banner:

- slides in under the chat header (200ms ease-out),
- carries a pulsing red dot,
- is `role="status"` `aria-live="polite"`,
- disappears the instant connectivity returns.

It deliberately does NOT block sending. The user can still hit Send and
the request will surface the same generic error a failed stream would.

---

## 10. Testing approach

| Layer | Tool | What it covers |
|---|---|---|
| Service (`messages.service.spec.ts`) | Jest + mocked repository | Detached generation lifecycle, disconnect-completes, throttled incremental persistence, reconnect snapshot+remaining-delta equality, completed-replay-without-AI, orphan honesty, idempotency reuse/conflict, replay, one-row-per-turn invariant. 21 specs. |
| HTTP smoke (`scripts/smoke-test.mjs`) | Node fetch | Full black-box: auth, ownership, plan authorization, model CRUD, **status='failed' + failed SSE event**, **meta carries assistantMessage + replay=false**, **clientMessageId reuse**, **Idempotency-Key header**, **content-mismatch → 400**. 75 checks. |
| Live resilience (`scripts/resilience-test.mjs`) | Node fetch + real aborts | **Detach-and-complete**: abort mid-stream → generation still completes; reconnect replay of completed rows creates no new rows; two clients on one live generation (snapshot + remaining deltas, no dup/missing tokens); foreign reconnect → 404; retry/replay row counts; Idempotency-Key round-trip; abort-before-send creates no rows. 28 checks. |
| Vite dev server smoke | `curl` against the SPA | Routes mount, ChatView bundle includes the new imports. |
| Frontend | `vue-tsc --noEmit` + production build | Type safety + compile. |

Browser GUI testing is intentionally not yet automated (no runner
available in the dev environment). Manual coverage is documented in
[STAGES.md §11](STAGES.md).

---

## 11. What we deliberately did NOT do

- **No WebSocket** — SSE is enough for one-way streaming.
- **No Redis / BullMQ / queue** — the database is the durable buffer.
- **No cross-process generation registry** — `GenerationRegistry` is
  in-process and in-memory only. The DB stays the source of truth; a server
  restart orphans in-flight rows, which are then honestly marked
  `interrupted` and offered for retry (no fake resume).
- **No `pending` row cleanup job** — an orphaned row is marked `interrupted`
  lazily when a client reconnects to it. A future hardening pass could add a
  periodic sweep for conversations nobody reopens.
- **No client-side retry queue for failed sends** — Retry is a
  deliberate user action. We never silently re-send.
- **No separate "regenerate" endpoint** — Retry today creates a new
  assistant row; "regenerate" is the same surface with different copy.
- **No token-level provider resume** — stateless completion APIs cannot
  resume a stream at a byte offset. The reconnect stream rejoins the SAME
  in-process generation while it is alive; once it is gone (restart), the
  partial content is kept and the row becomes retryable. No faked
  continuation, ever.
