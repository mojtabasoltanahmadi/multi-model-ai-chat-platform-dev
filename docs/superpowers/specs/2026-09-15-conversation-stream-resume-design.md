# Conversation Stream Resume — Design

**Date:** 2026-09-15
**Status:** Superseded — see note below
**Author:** (brainstorming session)
**Parent spec:** [docs/CONVERSATION_RESILIENCE.md](../../../docs/CONVERSATION_RESILIENCE.md)
**Scope:** Single phase. One feature. New endpoint + new module + small schema migration.

> **⚠ SUPERSEDED BY THE AS-BUILT IMPLEMENTATION.** This document records the
> brainstorming design (SSE `Last-Event-ID` cursor + `StreamRegistry` ring
> buffer + `last_event_id` column + auto-retry composable). The shipped
> implementation took a simpler and stronger path:
>
> - `GenerationRegistry` (in-process fan-out + authoritative content buffer)
>   instead of a ring buffer of numbered events;
> - a **snapshot-based reconnect stream** (`GET .../messages/:messageId/stream`):
>   subscribe-first, then snapshot of all content so far, then the remaining
>   deltas — no event ids, no `Last-Event-ID` header, no 410s, no ring-buffer
>   eviction window;
> - **detached generation**: client disconnect only unsubscribes; the answer
>   always completes and persists, so Tier-2 auto-retry-on-return was not
>   needed — the reconnect stream replays or joins the same generation, and
>   an orphaned row (server restart) is honestly marked `interrupted` for the
>   user to retry;
> - **no schema change** — no `last_event_id` column; status/content live on
>   the existing `messages` row.
>
> The authoritative, up-to-date contract is [docs/API.md](../../../API.md)
> (§ Reconnect / recovery stream) and
> [docs/CONVERSATION_RESILIENCE.md](../../../CONVERSATION_RESILIENCE.md).
> Everything below is kept for design-history traceability.

---

## 1. Problem statement

Today, refreshing the browser or reopening a tab mid-stream shows the
persisted partial response with a **Retry** button. The user loses any
in-flight deltas they were about to see and has to consciously click
Retry, which starts a brand-new assistant row.

This spec replaces that UX with a seamless continuation. Two tiers
of recovery:

1. **Auto-resume** when the server still holds a live buffer for the
   assistant row (typically within 60 seconds of the disconnect, or
   while a stream is still actively producing). The client joins the
   live SSE stream from its last seen event id and bytes continue
   arriving as if nothing happened.
2. **Auto-retry on return** when the buffer is gone (more than 60
   seconds after the stream ended, or after a server restart, or for
   a row that was already `interrupted` / `failed`). The client
   splices out the partial row and starts a fresh stream with the
   same `clientMessageId` (idempotency reuses the user row). No
   manual Retry button is shown.

**Threat model (from CONVERSATION_RESILIENCE.md §1) updated:**

| # | Event | New behavior |
|---|---|---|
| 1 | Refresh mid-stream | Auto-resume from cursor. Bytes continue arriving. No Retry. |
| 2 | Tab close mid-stream | Same as #1 on next visit. |
| 3 | Open a second tab mid-stream | Tab B joins the live stream from its own (lower) cursor. Server fans out the same events to both. |
| 4 | Internet drops mid-stream | LocalStorage holds the cursor. On reconnect, auto-resume picks up. |
| 5 | Provider failure | `status='failed'` (terminal). On next visit, auto-retry kicks off without a manual Retry click. |
| 6 | User hits Stop | `status='interrupted'` (terminal). On next visit, auto-retry kicks off without a manual Retry click. |
| 7 | User returns after >60s of interrupt | Buffer gone. Auto-retry starts a fresh assistant row. No Retry button shown. |

---

## 2. Approach

Two tiers of recovery, both implemented in this spec:

- **Tier 1 — SSE Last-Event-ID resume** for active streams. Standard
  HTTP semantics. No WebSocket, no Redis, no replay log.
  - The server tracks every active stream in memory: a ring buffer of
    recent events (id, name, data), a set of live subscribers, and
    the last issued event id.
  - Every event carries an `id:` line so the client (and the
    server's replay logic) can address it.
  - A new endpoint `GET /conversations/:id/messages/:messageId/stream`
    accepts an optional `Last-Event-ID` header. If present, the
    server replays buffered events with id > Last-Event-ID then
    attaches the client as a live subscriber.
  - The client persists its last seen event id per message in
    `localStorage` (keyed by `hooshyar.lastEventId.<messageId>`). On
    page load, if any assistant row has `status='streaming'` AND the
    server has a live buffer, the chat view kicks off a resume
    subscription automatically.
- **Tier 2 — Auto-retry on return** when the live buffer is gone
  (>60s after terminal, or after server restart) OR when the row is
  already `interrupted` / `failed`.
  - The client scans the loaded messages for terminal assistant
    rows, splices the partial out, and re-sends the same
    `clientMessageId`. Idempotency reuses the user row; a fresh
    assistant row streams in.
  - Bounded by a 10-minute localStorage flag per messageId so a
    persistently-failing AI doesn't loop.
  - The Retry button on `interrupted` / `failed` rows is removed.
    Users never see "Client disconnected before completion" +
    "تلاش مجدد"; they just see the new stream.

---

## 3. Architecture

### 3.1 New module: `StreamRegistry`

**Location:** `backend/src/streams/stream-registry.service.ts`

A process-wide singleton keyed by **assistant messageId**. One entry
per active stream:

```ts
interface StreamEntry {
  messageId: string;
  conversationId: string;
  /** Monotonically increasing, starts at 1. */
  nextEventId: number;
  /** Recent events for replay. Bounded ring buffer. */
  buffer: RingBuffer<{ id: number; event: string; data: string }>;
  /** Currently-attached live subscribers. */
  subscribers: Set<Response>;
  /** When this stream is scheduled to be evicted (post-terminal). */
  evictAt: NodeJS.Timeout | null;
}
```

**Public surface:**

| Method | Purpose |
|---|---|
| `register(messageId, conversationId): StreamEntry` | Create entry at stream start. |
| `nextEventId(messageId): { id: number; entry: StreamEntry }` | Atomically allocate the next id. |
| `record(messageId, id, event, data)` | Append to buffer + fan out to subscribers. |
| `subscribe(messageId, response, fromEventId: number): { replayed: number; liveAttached: true }` | Replay buffered events with id > fromEventId, then attach as live. |
| `scheduleEviction(messageId, ms = 60_000)` | On terminal status: clear the entry after 60s. |
| `drop(messageId)` | Immediate drop (used in error paths). |

**Ring buffer:** capacity 1000 events. When full, oldest event is
evicted. If a subscriber's `fromEventId` is older than the oldest
buffered id, the subscribe call sees the buffer has wrapped and the
controller returns 410.

**Memory bound:** O(active streams × 1000 events). At ~500 bytes/event,
that's ~500 KB per active stream. We assume well under 100 concurrent
streams in practice.

### 3.2 New endpoint

```
GET /api/conversations/:conversationId/messages/:messageId/stream
Authorization: Bearer <jwt>
Last-Event-ID: <integer>     (optional)

→ 200 text/event-stream    (live + optional replay; OR terminal replay of the final 'done' event)
→ 410 application/json     (buffer evicted OR terminal with a gap)
→ 401 application/json     (auth)
→ 403 application/json     (not your message)
→ 404 application/json     (message not found)
```

**Replay contract:**

The header value is interpreted as "I have received every event with
id <= Last-Event-ID." The server replays every buffered event with
`id > Last-Event-ID`, then attaches the client as a live subscriber.
Replay is gap-free up to the oldest buffered event id: if
`Last-Event-ID < buffer.oldestEventId - 1`, the next replayable event
has been evicted and the request returns 410 (see below).

**Server flow:**

1. Auth + ownership check (must own the conversation).
2. Load the assistant row by id.
3. If `status` is terminal (completed / interrupted / failed):
   - If the row's `lastEventId` column is null OR
     `Last-Event-ID < row.lastEventId`: return 410 with the row in
     the JSON body.
   - Else (client caught up): return 200 with a single `done` event
     carrying the row, then close the stream. Standard completion
     semantics on the client.
4. If `status` is `streaming` or `pending`:
   - Look up registry entry by messageId.
   - If absent: return 410 with the row (server restarted, buffer
     lost; client falls through to `useAutoRetryOnLoad`).
   - If `Last-Event-ID` is provided AND the buffer is non-empty AND
     `Last-Event-ID < buffer.oldestEventId - 1`: return 410 with the
     row (gap too large for replay). Client falls through to
     `useAutoRetryOnLoad`.
   - Else: write replay events (events with id > Last-Event-ID),
     attach as live subscriber, keep connection open.

**Response headers (live + replay):**
```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

### 3.3 SSE event wire format

Every event now carries an `id:` line:

```
id: 7
event: delta
data: {"text":"سلام "}

```

The existing event types (`meta`, `delta`, `done`, `error`) are
unchanged. `id:` is purely additive — existing clients ignore it.

### 3.4 DB schema change

Add one column to `messages`:

```sql
ALTER TABLE messages
  ADD COLUMN last_event_id INTEGER NULL;
```

**Write semantics:** updated **only** at terminal transitions (matches
CONVERSATION_RESILIENCE.md §3 — "streaming is NOT persisted on every
chunk"). Set by `MessagesService` alongside `status='completed'` /
`'interrupted'` / `'failed'`.

**Read semantics:** returned by `GET /conversations/:id` so a client
loading a fresh conversation knows the server's view of the final
event id. Useful for clients that lost localStorage and need a
baseline.

### 3.5 Frontend changes

**New function `resumeStreamMessage`** in `frontend/src/api/client.ts`
(mirrors `streamChatMessage`):
- `GET` request, no body.
- `Last-Event-ID` header if known.
- Same event dispatcher; reads `id:` lines alongside `event:` and
  `data:`.
- On `410`: resolves to a structured `{ kind: 'gone', message }` so
  the caller can fall back to the persisted snapshot.

**New composable `useResumeOnLoad`** in
`frontend/src/composables/useResumeOnLoad.ts`:
- Input: the loaded `messages` array (ref) and an `applyDelta` setter
  from the chat view.
- On mount: scan for `status === 'streaming'` assistant rows.
- For each: read `localStorage['hooshyar.lastEventId.<id>']` (if any),
  call `resumeStreamMessage` with that value.
- Pipe `meta` / `delta` / `done` / `error` events into the same
  streaming state machine used by the active send.
- Persist the latest event id on every delta.
- Clear localStorage on `done` / `error`.
- Return a `disposer` that aborts the active subscription when the
  chat view unmounts or the user navigates away.

**New composable `useAutoRetryOnLoad`** in
`frontend/src/composables/useAutoRetryOnLoad.ts`:
- Input: the loaded `messages` array (ref), a `send` function from
  the chat view, and a `streaming` ref guard.
- On mount: scan for the **most recent** assistant row with
  `status === 'interrupted'` or `status === 'failed'`.
- Find the user row immediately preceding it.
- Check `localStorage['hooshyar.autoRetried.<messageId>']` — if set
  and recent (< 10 minutes), skip. This prevents an infinite
  auto-retry loop if the AI provider keeps failing.
- Otherwise: splice the failed/interrupted assistant row out of the
  messages list (matches the existing `retry()` flow), and call
  `send(userRow.content, { clientMessageId: userRow.clientMessageId })`.
- Set the localStorage flag with the current timestamp.
- Clear the flag once the new attempt reaches a terminal status
  (success or fail).
- Bail out early if `streaming.value === true` (the user is mid-send;
  they shouldn't be auto-retried on top of an active send).

**`send()` change in `ChatView.vue`** to fix a pre-existing
duplicate-user-bubble bug surfaced by auto-retry:
- `send()` currently always pushes an `optimisticUser` row into
  `messages.value` before the server returns. For a brand-new send,
  this is necessary (the real user row doesn't exist yet). For a
  retry (manual OR auto), the real user row is already in the array,
  so the optimistic push creates a duplicate bubble.
- New `options.existingUserRowId?: string` parameter on `send()`.
  When provided, skip the optimistic push and reuse the existing row.
- The existing manual `retry()` is updated to pass
  `existingUserRowId: userRow.id`.
- `useAutoRetryOnLoad` likewise passes `existingUserRowId`.

**ChatView.vue:** after `loadMessages()` resolves, call
`useResumeOnLoad` (Tier 1: resume a live buffer if present) and
`useAutoRetryOnLoad` (Tier 2: auto-retry a terminal row if the buffer
is gone). On conversation switch, abort the prior resume subscription.

**Frontend rendering changes in `MessageItem.vue`:**
- For `status === 'interrupted'`: the Retry button is **hidden**
  (auto-retry handles it). The `errorMessage` text ("Client
  disconnected before completion.") is **not shown** — it is an
  internal server detail, not user-facing copy.
- For `status === 'failed'`: the Retry button is **hidden**.
  `errorMessage` is also hidden because the row is replaced by the
  auto-retry before the user has time to read it; the new attempt
  produces a fresh message.
- The Copy button and the completed-message styling are unchanged.

### 3.6 Tier 1 vs Tier 2 — which path runs

| On conversation load, for each assistant row… | Tier |
|---|---|
| `status === 'streaming'` AND server has a live buffer | Resume from cursor (3.5: `useResumeOnLoad`) |
| `status === 'streaming'` AND server has no buffer (restart) | Auto-retry (3.5: `useAutoRetryOnLoad`) |
| `status === 'interrupted'` | Auto-retry |
| `status === 'failed'` | Auto-retry |
| `status === 'completed'` | Nothing (render only) |
| `status === 'pending'` | Treat as streaming; resume or auto-retry |

The two tiers are sequenced: resume wins when it can produce bytes
without consuming an AI turn. Auto-retry only runs when resume returns
410 (no buffer / gap too large) or when the row is already terminal.

### 3.7 Multi-tab semantics

Two tabs on the same mid-stream conversation:

| Step | Tab A (joined first) | Tab B (joins later) |
|---|---|---|
| Last seen | 38 | 22 (joined earlier in stream) |
| Resume | (no resume — was live) | `Last-Event-ID: 22` |
| Server | Live | Replays 23..42, then attaches live |
| Subsequent deltas | Live | Live |
| `done` event | Received | Received |

Both tabs receive identical event ids. Each tracks its own
lastSeenEventId in localStorage (the values converge naturally as
both see the same events).

The `streaming.value` guard in the composer (existing) still prevents
either tab from initiating a new send while a stream is attached.

---

## 4. Data flow

### 4.1 Refresh mid-stream (happy path)

```
Browser refresh during a stream. Server is at event 50.

1. ChatView mounts.
2. GET /conversations/:id → messages array includes
     assistantRow: { status='streaming', content='<partial>', lastEventId=null }
3. useResumeOnLoad sees status='streaming', reads
     localStorage['hooshyar.lastEventId.<msgId>'] = 38.
4. Opens GET /conversations/:id/messages/:msgId/stream
     with Last-Event-ID: 38.
5. Server:
   - Entry exists. Buffer holds 1..50.
   - Replays events 39..50 to the new subscriber.
   - Attaches as live subscriber.
6. Client dispatches each replayed event:
   - deltas 39..50 are appended to streamingRow.content
     (idempotent — the persisted content already covers 1..38,
     so this just renders the missing bytes).
   - 'streaming' status is confirmed on each.
7. Server emits 51, 52, ... in real time.
   Client keeps appending.
8. Eventually 'done' fires.
   - lastEventId=NN persisted to DB.
   - Buffer scheduled for eviction in 60s.
   - Client clears localStorage entry.
   - streamingRow.status = 'completed'.
```

### 4.2 Buffer evicted (stream terminated long ago) → Auto-retry

```
Stream finished 5 minutes ago. Buffer evicted. lastEventId=80.
Row is `completed` in DB.

1. ChatView mounts. GET response includes the completed row.
2. useResumeOnLoad: status is terminal, no resume.
3. useAutoRetryOnLoad: status is `completed`, not interrupted/failed —
   no auto-retry.
4. Renders the persisted row. Standard completed-message UI.

(If the row had been `interrupted` or `failed` instead:)

1. ChatView mounts. GET response includes the interrupted row +
   the preceding user row with its clientMessageId.
2. useResumeOnLoad: status is terminal, no resume.
3. useAutoRetryOnLoad: status is `interrupted` (or `failed`).
4. Checks localStorage 'hooshyar.autoRetried.<messageId>' — empty,
   so it proceeds.
5. Splices the interrupted row out of messages.value.
6. Calls send(userRow.content, { clientMessageId: <persisted id> }).
7. Server recognizes the idempotency, reuses the user row, persists
   a fresh assistant row with status='pending', streams it.
8. Client renders the new streaming row.
9. localStorage flag is set so we don't auto-retry again within 10
   minutes if THIS attempt also fails.
```

### 4.3 Server restart → Auto-retry

```
Server restarts mid-stream. Buffer gone. Row still `streaming` in DB.

1. ChatView loads. status='streaming' (the row never moved to a
   terminal state because the server crashed before persisting).
2. useResumeOnLoad: opens GET .../stream with Last-Event-ID from
   localStorage (or absent).
3. Server: no registry entry → returns 410.
4. useResumeOnLoad resolves to `{ kind: 'gone' }`. The row is left
   as-is (status='streaming', partial content).
5. useAutoRetryOnLoad: scans for terminal-or-streaming rows. The
   row is 'streaming' (not terminal) — auto-retry does NOT fire
   here because we can't tell if another process picked up the
   stream. The user sees the persisted partial + a small
   "در حال اتصال..." indicator.
6. After ~10 seconds with no live bytes arriving, useResumeOnLoad
   gives up (timeout) and useAutoRetryOnLoad treats the row as
   effectively terminal and retries.

(If the row were already terminal in the DB at restart time, the
plain auto-retry flow from §4.2 runs.)
```

---

## 5. Error handling

| Failure | Status | Client behavior |
|---|---|---|
| Resume: buffer evicted / gap too large | 410 | Falls through to useAutoRetryOnLoad. No error toast. |
| Auto-retry: AI provider fails again | (re-enters `failed`) | Row goes back to `failed`. localStorage flag set so we don't loop. The user sees a fresh failed row on next visit (one auto-retry attempt per 10 minutes per messageId). |
| Auth expired | 401 | Same logout flow as today (CONVERSATION_RESILIENCE.md §10). |
| Not your conversation/message | 403 / 404 | Conversation reload. |
| Network error during resume | (transport) | Same generic "ارتباط هنگام دریافت پاسخ قطع شد." toast. The persisted row remains visible. Auto-retry handles it. |
| Network error during auto-retry | (transport) | Same toast. The interrupted row remains visible. The next visit will retry again (within the 10-minute window, the flag prevents it; beyond that, it retries). |
| Slow subscriber falls > 1000 events behind | (server closes conn) | Subscriber receives the events it has, then conn closes. Next resume sees 410. |

Auto-retry is bounded (10-minute flag per messageId), not infinite.
Matches CONVERSATION_RESILIENCE.md §11 ("No client-side retry queue
for failed sends — Retry is a deliberate user action"). Auto-retry
on return IS the deliberate user action — it happens once, when the
user explicitly opens the conversation.

---

## 6. Testing

| Layer | Tool | What it covers |
|---|---|---|
| `stream-registry.service.spec.ts` | Jest | Register/record/subscribe, ring buffer eviction at size 1000, multi-subscriber fan-out, scheduleEviction firing after 60s, drop immediate, 410 lookup when no entry. |
| `messages.service.spec.ts` (extend) | Jest | Stream registers on start, deregisters on terminal, `lastEventId` persisted on done/interrupted/failed, NOT persisted on first delta. |
| `messages.controller.spec.ts` (extend or new) | Jest | GET endpoint: 200 + SSE replay, 410 no-buffer, 410 gap, 410 terminal-with-gap, 200 terminal-caught-up (final `done` event), 401, 403, 404, replay ordering. |
| `scripts/resume-test.mjs` (new) | Node fetch + real aborts | Two concurrent connections receive the same final `done`. Last-Event-ID replay produces no duplicates and no gaps. 410 path. Terminal + 60s eviction verified via stub. |
| `scripts/auto-retry-test.mjs` (new) | Node fetch | Stream interrupted → 410 on resume → auto-retry kicks off → fresh assistant row streams to completion. Stream `failed` → auto-retry kicks off → fresh assistant row. Auto-retry loop bounded by 10-minute flag. |
| Existing `resilience-test.mjs` (extend) | Node fetch | Existing interrupted scenarios still pass; new "refresh mid-stream then auto-join" scenario. |
| `frontend/src/api/client.ts` (extend) | Manual / vite build | resumeStreamMessage dispatches all event types correctly; 410 falls back gracefully. |
| `useResumeOnLoad.spec.ts` (new) | Vitest | Reads localStorage on mount; aborts on unmount; clears localStorage on done. |
| `useAutoRetryOnLoad.spec.ts` (new) | Vitest | Fires for interrupted/failed rows; skips when localStorage flag is set within window; splices the partial row; calls send() with the persisted clientMessageId; sets the flag. |
| `MessageItem.vue` (manual + screenshot diff) | Vitest snapshot | No Retry button for `interrupted`/`failed`. No `errorMessage` paragraph for `interrupted`. |
| Build | `vue-tsc --noEmit`, `nest build` | Compile clean. |

Browser GUI testing remains manual (no runner available), documented
in `docs/STAGES.md`.

---

## 7. What we deliberately do NOT do

Carried over from CONVERSATION_RESILIENCE.md §11 and added:

- **No optimistic concurrency on the assistant row.** Multiple tabs
  can subscribe but only one new send can be in flight at a time
  (the `streaming.value` guard).
- **No per-delta DB writes.** `lastEventId` is set at terminal only.
- **No Redis / replay log.** The in-memory ring buffer is the entire
  resume surface.
- **No "resume from byte 0" replay.** A fresh subscriber without
  Last-Event-ID attaches live only and relies on the persisted
  snapshot from the GET response.
- **No cross-tab leader election.** Both tabs independently
  subscribe; both receive the same events. The composer is shared.
- **No buffer persistence across server restarts.** Restart = 410 for
  anyone mid-resume. The `pending` row cleanup gap remains.
- **No infinite auto-retry loop.** Auto-retry on return is bounded by
  a 10-minute localStorage flag per messageId. Beyond that window a
  manual interaction (new send) is required.
- **No manual Retry button on `interrupted` or `failed` rows.**
  Auto-retry on return handles them; the user has no second chance
  to click a button they never see.

---

## 8. Rollout & migration

1. **Schema migration:** additive `last_event_id` column. Safe to
   deploy before code; the column is `NULL` for all existing rows.
2. **Backend deploy:** `StreamRegistry` module ships; `writeEvent`
   emits `id:` lines; new GET endpoint live. Existing POST flow
   unchanged.
3. **Frontend deploy:**
   - `resumeStreamMessage` + `useResumeOnLoad` ship together. Tier 1.
   - `useAutoRetryOnLoad` ships. Tier 2.
   - `MessageItem.vue` change: hide Retry button + `errorMessage`
     paragraph for `interrupted`/`failed` rows.
   - `ChatView.vue` `send()` change: new `existingUserRowId` option
     to fix the duplicate-user-bubble bug surfaced by auto-retry.
     The existing manual `retry()` is updated in the same commit.
   - ChatView wires both composables after `loadMessages()`.
   - No flag flip needed — auto-retry is silent and falls back
     gracefully if the server hasn't shipped yet.
4. **No DB backfill.** `last_event_id` populates on the next terminal
   transition for each row.
5. **UX change visibility:** the existing Retry button for
   `interrupted`/`failed` rows is removed in this release. Users who
   relied on clicking Retry will see auto-retry kick off instead.
   This is the intended behavior change; documented in the release
   notes (not in this spec).

---

## 9. Decisions on previously-open questions

(Decisions taken when the user said "continue" without explicit
answers on these; documented here for traceability.)

1. **`messages.last_event_id` column:** **Kept.** Used for the 410
   path's freshness check and as a "server's view of head" returned
   in `GET /conversations/:id`. Set at terminal only. Dropping the
   column would force the 410 path to read `createdAt` and
   `content.length` heuristics — less precise.

2. **Replay + live in one stream:** **Yes, single continuous
   stream.** The server writes replay events first, then continues
   with live. Same wire format, same event types, same parser. Two
   blocks would force the client to handle a "replay done" marker.

3. **Backpressure:** **Ring buffer drops oldest; subscriber falls
   behind → 410 on next resume.** No synthetic `interrupted` event.
   Keeps the resume protocol simple.
