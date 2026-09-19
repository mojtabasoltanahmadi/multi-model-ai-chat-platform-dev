/** Shared default so the multer interceptor and the service agree on the cap. */
export const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Parses an optional positive integer env value; unset/invalid ⇒ undefined. */
export function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Files attachable to one message. Shared by the DTO (boundary validation) and
 * the service (the single gate for AI context) so the two can never disagree.
 */
export const DEFAULT_MAX_FILES_PER_MESSAGE = 6;

export default () => ({
  port: parseInt(process.env.PORT ?? '4000', 10),
  database: {
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
    name: process.env.DB_NAME ?? 'ai_chat_mvp',
    synchronize: process.env.DB_SYNCHRONIZE !== 'false',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-only-insecure-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '1d',
  },
  admin: {
    email: process.env.ADMIN_EMAIL ?? 'admin@example.com',
    password: process.env.ADMIN_PASSWORD ?? 'admin1234',
  },
  ai: {
    requestTimeoutMs: parseInt(process.env.AI_REQUEST_TIMEOUT_MS ?? '60000', 10),
    // How often an in-flight generation flushes partial content to the DB.
    // Bounds the text a crash can lose to roughly one interval of tokens.
    persistIntervalMs: parseInt(process.env.AI_PERSIST_INTERVAL_MS ?? '1500', 10),
  },
  // ---- Usage & quota (day-7-8 contract §7) ----
  // Daily message quota per plan, enforced pre-stream (429 as clean JSON).
  // These env values ARE the "admin-defined limits" for the MVP: they are
  // product-tunable per deployment without a settings table or endpoint.
  quota: {
    freeDailyMessages: parseInt(process.env.QUOTA_FREE_DAILY_MESSAGES ?? '50', 10),
    premiumDailyMessages: parseInt(process.env.QUOTA_PREMIUM_DAILY_MESSAGES ?? '500', 10),
    // Daily token cap per plan (input + output, provider-reported or
    // chars/4-estimated). Unset ⇒ unlimited — the check is opt-in so default
    // deployments keep the message-quota-only behavior.
    freeDailyTokens: parseOptionalInt(process.env.QUOTA_FREE_DAILY_TOKENS),
    premiumDailyTokens: parseOptionalInt(process.env.QUOTA_PREMIUM_DAILY_TOKENS),
  },
  // ---- File uploads & background processing (Day 5-6) ----
  files: {
    maxFileSizeBytes: parseInt(
      process.env.FILE_MAX_SIZE_BYTES ?? String(DEFAULT_MAX_FILE_SIZE_BYTES),
      10,
    ),
    // Extracted text sent to the AI per message, across all attached files.
    maxContextChars: parseInt(process.env.FILE_MAX_CONTEXT_CHARS ?? '24000', 10),
    // Per-message attachment cap keeps the prompt and the UI sane for the MVP.
    maxFilesPerMessage: parseInt(
      process.env.FILE_MAX_PER_MESSAGE ?? String(DEFAULT_MAX_FILES_PER_MESSAGE),
      10,
    ),
  },
  storage: {
    endpoint: process.env.MINIO_ENDPOINT ?? 'localhost',
    port: parseInt(process.env.MINIO_PORT ?? '9000', 10),
    useSsl: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
    bucket: process.env.MINIO_BUCKET ?? 'chat-files',
  },
  // ---- Web search (opt-in per chat turn; Serper for the MVP) ----
  websearch: {
    enabled: process.env.WEB_SEARCH_ENABLED === 'true',
    provider: process.env.WEB_SEARCH_PROVIDER ?? 'serper',
    serperApiKey: process.env.SERPER_API_KEY ?? '',
    maxResults: parseInt(process.env.WEB_SEARCH_MAX_RESULTS ?? '5', 10),
    timeoutMs: parseInt(process.env.WEB_SEARCH_TIMEOUT_MS ?? '5000', 10),
    maxQueryLength: parseInt(process.env.WEB_SEARCH_MAX_QUERY_LENGTH ?? '500', 10),
    // Cap on the search block injected into the model prompt.
    maxContextChars: parseInt(process.env.WEB_SEARCH_MAX_CONTEXT_CHARS ?? '6000', 10),
  },
  queue: {
    redisHost: process.env.REDIS_HOST ?? 'localhost',
    redisPort: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    // Extraction is bounded: a stuck job fails instead of blocking a worker
    // slot forever.
    processingTimeoutMs: parseInt(process.env.FILE_PROCESSING_TIMEOUT_MS ?? '120000', 10),
    // A PROCESSING row with no activity for this long is presumed orphaned
    // (worker crash / lost job) and is re-enqueued by the sweeper.
    staleProcessingMs: parseInt(process.env.FILE_STALE_PROCESSING_MS ?? '600000', 10),
  },
  ocr: {
    language: process.env.OCR_LANGUAGE ?? 'eng',
    // Where tesseract.js caches the downloaded language data. Defaults to a
    // temp dir so the repository stays clean.
    cachePath: process.env.OCR_CACHE_PATH ?? '',
    // Optional local `tessdata` directory for air-gapped installs (skips the
    // language-data download entirely).
    dataPath: process.env.OCR_DATA_PATH ?? '',
  },
});
