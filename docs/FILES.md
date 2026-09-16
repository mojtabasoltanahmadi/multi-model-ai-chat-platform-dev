# File upload & asynchronous processing (Day 5–6)

Users can attach **PDF**, **Excel** and **image** files to a conversation. The upload itself is
fast (store + record + enqueue); the expensive work — PDF text extraction, spreadsheet
parsing, image OCR — runs in a **background BullMQ worker**. Chat keeps working while a file
is processing, and a file only ever reaches the AI once its status is `READY`.

```
POST /conversations/:id/files
  │ authenticate + conversation ownership (404 for foreign ids, before any side effect)
  │ validate: non-empty, ≤ size limit, allowed declared MIME, content signature, extension
  ▼
MinIO  files/{userId}/{conversationId}/{uuid}.<ext>      ← server-generated key, never the filename
  ▼
PostgreSQL  files row, status = UPLOADING                 ← upload transaction
  ▼
BullMQ  file-processing  { fileId }                       ← metadata only; the binary stays in MinIO
  ▼
Worker (in-process, concurrency 2)
  │ atomic claim  UPLOADING|PROCESSING → PROCESSING
  │ read object → extract text → persist text + status in one update
  ▼
READY  (extracted text stored)        or        FAILED  (safe Persian reason stored)
```

See [API.md](API.md) for the endpoint reference and [ARCHITECTURE.md](ARCHITECTURE.md) for how
the module fits the rest of the system.

## Supported types and limits

| Kind | Accepted content | Canonical MIME stored |
|---|---|---|
| PDF | `%PDF-` header | `application/pdf` |
| Excel | OLE2 container with a `Workbook`/`Book` stream (`.xls`), or a zip workbook containing `[Content_Types].xml` + `xl/` (`.xlsx`) | `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| Image | PNG signature, or `FF D8 FF` (JPEG) | `image/png`, `image/jpeg` |

Rules enforced at upload (`validateUploadedFile`):

1. the file is non-empty and within `FILE_MAX_SIZE_BYTES` (default **10 MB**);
2. the **declared** MIME belongs to one of the three families;
3. the **content** matches a supported signature, and its family agrees with the declared one
   (a `.png` renamed to `report.pdf` with PDF bytes passes; a `.doc` OLE2 file does not);
4. the **extension**, when present, is on the allowlist and agrees with the content.

Only the extension is never trusted on its own — it is a third, independent signal. Path
separators and control characters are stripped from the display name, and a whitespace-only
name becomes `بدون‌نام`.

## File lifecycle (state machine)

```
UPLOADING  → PROCESSING        worker claimed the job
PROCESSING → READY             extraction persisted
PROCESSING → FAILED            permanent error, or retries exhausted
READY      → PROCESSING        explicit admin reprocess only
FAILED     → PROCESSING        explicit admin reprocess only
```

`FILE_STATUS_TRANSITIONS` + `canTransition()` in `file.entity.ts` define the table;
`File.assertTransition()` throws a 400 for anything else, and the worker uses a conditional
`UPDATE ... WHERE status IN ('UPLOADING','PROCESSING')` so the claim is atomic. A `READY` file
therefore cannot silently slide back into `PROCESSING` — only `POST /admin/files/:id/reprocess`
resets `attempts`/`errorMessage` and transitions it explicitly.

Invariants that hold at every moment:

- **READY ⇒ extracted content exists.** Status and `extracted_text` are written in the same
  update; there is no window where a file is READY with no text.
- **PROCESSING ⇒ a recoverable job exists.** The row is only flipped by the worker that holds
  the job, and the orphan sweeper re-enqueues rows whose job was lost.
- **FAILED ⇒ a safe reason exists.** `error_message` is always populated; stack traces stay in
  the server logs.

## Data model

`files` (TypeORM entity `File`):

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `user_id` → `users` | owner, `ON DELETE CASCADE`, indexed |
| `conversation_id` → `conversations` | owning conversation, `ON DELETE CASCADE`, indexed |
| `original_name` | sanitized display name only (≤ 255) |
| `mime_type` | resolved from content, not the client claim |
| `size` | bytes |
| `storage_key` | MinIO object key |
| `status` | `UPLOADING \| PROCESSING \| READY \| FAILED` |
| `extracted_text` | `text`, null until READY |
| `error_message` | safe user-facing reason (Persian) |
| `attempts` | attempts consumed by the current processing cycle (reset on reprocess) |
| `created_at` / `updated_at` | |

Indexes: `(conversation_id, status)` for the chat file list, `(status, updated_at)` for the
orphan sweeper.

**Storage layout.** The binary never enters PostgreSQL. Keys are always server-generated:

```
chat-files/
  files/{userId}/{conversationId}/{random-uuid}.<ext>
```

The original filename is not part of the key, so a hostile name cannot traverse paths or
collide with another user's object. Credentials stay server-side; the browser never talks to
MinIO.

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/conversations/:conversationId/files` | `multipart/form-data`, field `file`. Returns **201** with the safe file shape. Foreign conversation → 404. No extraction happens here. |
| GET | `/conversations/:conversationId/files` | files of a conversation (for reload/refresh restore) |
| GET | `/files/:fileId` | single file status — the polling endpoint |
| GET | `/admin/files?status=&limit=&offset=` | admin only; status counts + paginated rows |
| GET | `/admin/files/stats` | admin only; row counts + live queue depth |
| POST | `/admin/files/:fileId/reprocess` | admin only; `READY`/`FAILED` → `PROCESSING` and a fresh job |

The safe shape returned for a file is
`{ id, userId, conversationId, originalName, mimeType, size, status, errorMessage, attempts, createdAt, updatedAt }`.
**`extractedText` and `storageKey` never leave the backend** — the extracted text is only ever
consumed server-side when building the AI prompt.

Sending a message with attachments adds `fileIds: string[]` (≤ 5, uuids) to the existing
`POST /conversations/:id/messages` body; the persisted user message stores them in
`messages.attached_file_ids` (jsonb) so the UI can re-render the chips after a reload.

## Queue & worker

- Queue `file-processing`, one job per file, payload `{ fileId }`. **No binary is ever put in
  Redis**; the worker re-reads the object from MinIO.
- `jobId = fileId`, `attempts: 3`, exponential backoff from 3 s, `removeOnComplete` 1 h/1000,
  `removeOnFail` 24 h. The job id collapses duplicate enqueues (upload retry, sweeper) into one
  job; enqueueing over a still-retained terminal job first removes it, because BullMQ would
  otherwise **silently drop** the add and leave the row stuck in `PROCESSING`.
- Worker: `FileProcessor` (`@Processor(..., { concurrency: 2 })`, in-process with the API).
  Transport is deliberately thin — the logic lives in `FileProcessingService`, which keeps it
  unit-testable without the queue runtime. Concurrency 2 lets one slow OCR job coexist with
  quick PDF/Excel jobs.
- **Idempotency.** A duplicate delivery of a finished job is skipped (`READY`/`FAILED` rows
  return early); two live runs cannot process the same row concurrently because the claim is a
  conditional update that only one can win. Uploads always create exactly one row.
- **Orphan sweeper.** Every 60 s, rows stuck in `UPLOADING` for > 2 min (enqueue failed after a
  successful upload) or in `PROCESSING` for > `FILE_STALE_PROCESSING_MS` (worker crash) are
  re-enqueued. A row that already consumed 3 attempts is marked `FAILED` with an honest reason
  instead of being retried forever.
- **Timeout.** Each extraction run is bounded by `FILE_PROCESSING_TIMEOUT_MS` (default 120 s);
  a timeout is treated as transient, so it retries and finally fails.

### Retry classification

| Class | Examples | Behaviour |
|---|---|---|
| Transient | MinIO/network hiccup, extraction timeout, unknown extractor error | rethrown → BullMQ retries with backoff; the row stays `PROCESSING` with a live job; the last attempt marks `FAILED` |
| Permanent (`PermanentExtractionError`) | corrupt PDF, encrypted PDF, Excel with no sheets/data, image with no detectable text, unsupported content | immediate `FAILED` — no retry can succeed |

Retries are always bounded (3 attempts); there is no infinite loop.

## Extraction pipelines

- **PDF** — `pdf-parse` (pdf.js). Page text is normalized with `— صفحه N —` separators. A PDF
  with no extractable text layer (scanned/image-only) **fails explicitly** — success is never
  faked with empty content. Corrupt/encrypted PDFs are permanent failures.
- **Excel** — SheetJS. The workbook is serialized as a readable table per sheet:

  ```
  Sheet: Customers
  Name | Age | City
  Ali  | 22  | Mashhad
  ```

  Multiple sheets are labeled; an empty sheet renders `(این شیت خالی است)`. A file with no
  sheets or no rows at all is a permanent failure. A workbook-format guard runs before parsing
  because SheetJS would otherwise "successfully" parse arbitrary text as CSV.
- **Image / OCR** — `tesseract.js` (pure JS, no native dependencies). Language comes from
  `OCR_LANGUAGE` (default `eng`); language data downloads on first use and is cached outside the
  repository (`OCR_CACHE_PATH`, default a temp dir). Air-gapped installs can point
  `OCR_DATA_PATH` at a local `tessdata` directory. An image with no recognizable text is a
  permanent failure. If OCR cannot run in the environment, the file fails — it is never reported
  as successfully processed.

## Chat integration

`FilesService.getReadyContext(conversationId, fileIds)` is the only gate for using file content,
and it enforces both conditions **in the query**: the file belongs to *this* conversation, and
its status is `READY`. Anything else rejects the whole send with a clear Persian message:

| Situation | Response |
|---|---|
| `UPLOADING` / `PROCESSING` | 400 «این فایل هنوز در حال پردازش است…» |
| `FAILED` | 400 «پردازش این فایل ناموفق بوده است…» |
| unknown id, or a file of another conversation/user | 400 «فایل پیوست پیدا نشد یا به این گفتگو تعلق ندارد.» (foreign files are never confirmed to exist) |
| more than 5 ids | 400 (and the DTO caps the array at 5) |

`buildContextualPrompt()` then wraps the extracted text in explicit `[محتوای فایل‌های پیوست‌شده]`
delimiters before the user's text. **Context protection:** the total attached text per message
never exceeds `FILE_MAX_CONTEXT_CHARS` (default 24 000); the budget is split evenly across the
attached files so one huge document cannot starve the others, and every shortened file gets an
explicit `[…] متن این فایل به دلیل حجم زیاد کوتاه شد.]` note instead of being silently cut.
With no attachments the prompt is byte-identical to the pre-feature behaviour — the Day 1–4 chat
path is untouched.

## Failure handling & recovery

| Failure window | Consequence | Recovery |
|---|---|---|
| MinIO write throws | upload fails with 4xx/5xx, no DB row | user retries |
| MinIO write ok, DB insert fails | best-effort object delete | no orphan object, no row |
| DB row ok, enqueue fails | row stays `UPLOADING`; upload still returns 201 | sweeper re-enqueues within ~2 min |
| Worker crashes mid-extraction | row stays `PROCESSING` with no job | sweeper re-enqueues after `FILE_STALE_PROCESSING_MS`; processing is idempotent |
| Redis down | chat unaffected; uploads still succeed and are queued later by the sweeper | sweeper |
| MinIO down | uploads fail clearly; chat unaffected | retry |
| Duplicate job delivery | no double processing, no duplicate rows | skipped / atomic claim |

No distributed transaction is attempted; every window above is observable in the logs and
recoverable without manual SQL.

## Security

- Every file read/upload re-checks ownership server-side; foreign files and conversations return
  **404** so existence is not leaked, and the ownership filter is part of the query.
- Attaching a file only ever resolves ids **inside the conversation being written to**, so a
  forged `fileId` cannot pull another user's content into a prompt.
- Content signatures are validated, not trusted from the client; MIME/extension mismatches are
  rejected.
- Storage keys are server-generated; the filename only ever becomes a display string.
- Admin endpoints are guarded by `@Roles('admin')` + the global `RolesGuard`; the frontend route
  guard is convenience only. The admin payload exposes no extracted text and no stack traces —
  failed rows carry the same safe reason the user sees.
- MinIO credentials never reach the frontend, and there are no public bucket URLs.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `FILE_MAX_SIZE_BYTES` | `10485760` (10 MB) | per-file upload cap (multer + service) |
| `FILE_MAX_CONTEXT_CHARS` | `24000` | extracted text budget per message |
| `FILE_MAX_PER_MESSAGE` | `5` | attachments per message |
| `FILE_PROCESSING_TIMEOUT_MS` | `120000` | bound on one extraction run |
| `FILE_STALE_PROCESSING_MS` | `600000` | sweeper threshold for orphaned `PROCESSING` rows |
| `MINIO_ENDPOINT` / `MINIO_PORT` / `MINIO_USE_SSL` | `localhost` / `9000` / `false` | object storage |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | `minioadmin` (dev) | storage credentials |
| `MINIO_BUCKET` | `chat-files` | bucket, created idempotently at startup |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | BullMQ broker |
| `OCR_LANGUAGE` | `eng` | tesseract language(s) |
| `OCR_CACHE_PATH` | temp dir | language-data cache location |
| `OCR_DATA_PATH` | *(empty)* | local `tessdata` dir for air-gapped installs |

## Local development

```bash
docker compose -f infra/docker-compose.yml up -d      # postgres, redis, minio
cd backend && npm install && npm run start:dev        # bucket + queue wired automatically
cd frontend && npm run dev
```

- The compose file adds `redis` (6379) and `minio` (9000 API / 9001 console, credentials from
  `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, defaults `minioadmin`). The Postgres service is
  unchanged apart from its host port.
- The backend creates the bucket on startup if it is missing. If MinIO is unreachable at boot
  the API still starts (chat works); uploads fail with a clear error until it returns.
- The worker runs **inside the backend process** (`npm run start:dev` also processes files). A
  separate worker process is a future improvement, not an MVP requirement.
- OCR language data is downloaded on first image upload — expect a few seconds the first time.
  `OCR_DATA_PATH` avoids the download entirely.

## Observability

Structured log events (no file contents, no secrets ever logged):

```
file.upload.completed            fileId, userId, conversationId, size, mime
file.upload.db_failed            storageKey, userId
file.upload.enqueue_failed       fileId
file.processing.enqueued         fileId
file.processing.started          fileId, userId, conversationId, jobId, attempt
file.processing.completed        fileId, chars
file.processing.retry            fileId, attempt/maxAttempts, reason
file.processing.failed           fileId, permanent?, attempts, reason
file.processing.orphan_recovered fileId, status, attempts, conversationId
file.processing.skipped          fileId, reason (deleted | claimed_elsewhere | terminal status)
file.processing.worker_error     message
file.reprocess                   fileId, adminId
```

`GET /admin/files/stats` exposes row counts per status plus live queue depth for a quick
operational view.

## Known MVP limitations

- The worker is in-process with the API (no separate worker deployment); a crash takes both down
  and the sweeper recovers the work on the next boot.
- OCR is CPU-bound and single-language by default; no OCR quality tuning, no rotation/deskew.
- No antivirus/malware scanning, no image dimension limits beyond the file-size cap.
- No presigned download endpoint and no file preview — files are context, not attachments to
  download.
- No extracted-text management UI (admins see status, size, error — not content).
- Polling (not push) for status updates on the frontend.
- Scanned PDFs are not OCR-ed (a PDF with no text layer fails rather than rasterizing pages).

## Verification

- `backend`: 162 unit tests (`npx jest`) — validation, state machine, extraction (real PDF +
  real xlsx + mocked OCR), processor (idempotency, permanent vs transient, retry exhaustion,
  sweeper), upload/ownership/context rules, and the Day 1–4 suites.
- `scripts/file-processing-test.mjs` — 43 end-to-end checks against a live stack (upload PDF /
  Excel / image → READY, corrupt file → FAILED, validation, cross-user denial, admin view,
  reprocess, refresh recovery, and chat while a file is still `PROCESSING`).
- `scripts/smoke-test.mjs` — the Day 1–4 regression suite, 75/75 green after this feature.
