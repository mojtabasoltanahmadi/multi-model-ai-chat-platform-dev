/** API contract types — mirror the backend entities (see docs/API.md). */

export type UserRole = 'user' | 'admin';

/** Subscription plan — the backend re-reads it per request (never from JWT). */
export type UserPlan = 'free' | 'premium';

export interface User {
  id: string;
  email: string;
  role: UserRole;
  /** Present on fresh reads (/usage/me); the cached session may omit it. */
  plan?: UserPlan;
}

export interface AuthResponse {
  accessToken: string;
  user: User;
}

export interface Conversation {
  id: string;
  title: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

export type MessageRole = 'user' | 'assistant';
/**
 * Lifecycle of an assistant turn. Persisted on the backend row, so a refresh
 * mid-stream can read the latest value from PostgreSQL instead of guessing.
 *  - 'pending'    : row exists, AI has not started yet
 *  - 'streaming'  : AI is producing deltas (in-memory on the server)
 *  - 'completed'  : AI finished successfully
 *  - 'interrupted': client disconnected mid-stream; partial content kept
 *  - 'failed'     : AI call failed; errorMessage has the detail
 *
 * User rows have status = null.
 */
export type MessageStatus =
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'interrupted'
  | 'failed';

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  status: MessageStatus | null;
  errorMessage: string | null;
  modelId: string | null;
  /** Client-generated idempotency token; present on user rows. */
  clientMessageId: string | null;
  /**
   * READY files that were attached as context to this user turn. The ids are
   * resolved against the conversation's file list to render the chips, so a
   * reload shows the attachment without the file content ever leaving the
   * backend.
   */
  attachedFileIds: string[] | null;
  createdAt: string;
}

/**
 * Lifecycle of an uploaded file (backend `FileStatus`).
 * UPLOADING/PROCESSING are in-flight; only READY content may be used as chat
 * context; FAILED carries a user-safe reason.
 */
export type ChatFileStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED';

export interface ChatFile {
  id: string;
  userId: string;
  conversationId: string;
  originalName: string;
  mimeType: string;
  size: number;
  status: ChatFileStatus;
  /** Safe, human-readable failure reason (Persian) — never a stack trace. */
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Client-side upload lifecycle of a composer chip. Independent of the server
 * status: a file can be `completed` here (fully uploaded) while the backend is
 * still `PROCESSING` its content.
 */
export type FileUploadState = 'pending' | 'uploading' | 'completed' | 'error';

/**
 * A file waiting in the composer: the server record (once it exists) plus the
 * local upload bookkeeping the chip renders. `source` is the picked File, kept
 * so a failed upload can be retried without asking the user to pick it again.
 */
export interface ComposerFile extends ChatFile {
  upload: FileUploadState;
  /** Client-side upload failure reason — distinct from a processing failure. */
  uploadError?: string | null;
  source?: File;
}

/** Admin file view row: the file plus owner/conversation context. */
export interface AdminChatFile extends ChatFile {
  userEmail: string | null;
  conversationTitle: string | null;
}

/** Per-status row counts for the admin panel. */
export interface FileStatusCounts {
  UPLOADING: number;
  PROCESSING: number;
  READY: number;
  FAILED: number;
  total: number;
}

export interface AdminFilesResponse {
  total: number;
  counts: FileStatusCounts;
  items: AdminChatFile[];
}

export interface AdminFileStatsResponse {
  counts: FileStatusCounts;
  queue: { waiting: number; active: number; failed: number; completed: number } | null;
}

/**
 * Provider kinds — mirrors the backend `AiProviderKind` and its registered
 * adapters (see backend/src/ai/adapters/). Adding a kind is a backend change
 * first; this union, the provider labels and ProviderMark follow it.
 */
export type AiProviderKind = 'mock' | 'openai-compatible' | 'anthropic' | 'google';

/**
 * Closed capability set declared per model (mirrors backend
 * MODEL_CAPABILITIES). Capabilities unlock opt-in features; they are metadata
 * for the picker until the matching feature ships.
 */
export const MODEL_CAPABILITIES = ['web-search', 'reasoning'] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/** Persian labels for capability chips (picker + admin panel). */
export const MODEL_CAPABILITY_LABELS: Record<ModelCapability, string> = {
  'web-search': 'جستجوی وب',
  reasoning: 'استدلال',
};

/** Model as returned by the API — the provider API key is never included. */
export interface AiModel {
  id: string;
  name: string;
  provider: AiProviderKind;
  externalModelId: string;
  baseUrl: string | null;
  isActive: boolean;
  /** Available to users on the FREE plan (independent of isActive). */
  isFree: boolean;
  isDefault: boolean;
  /** Declared capabilities from the closed set; empty list by default. */
  capabilities: ModelCapability[];
  createdAt: string;
  hasApiKey: boolean;
}

// ---- Pricing (admin-only fields, INV-14: never exposed to non-admin clients) ----

/**
 * Model as returned by the ADMIN endpoints: SafeModel + pricing. The
 * user-facing /models response never carries these fields.
 */
export interface AdminModel extends AiModel {
  inputPricePerMillion: string | null;
  outputPricePerMillion: string | null;
}

export interface CreateModelPayload {
  name: string;
  provider: AiProviderKind;
  externalModelId: string;
  baseUrl?: string;
  apiKey?: string;
  capabilities?: ModelCapability[];
  /** Toman per 1M input tokens; empty ⇒ not priced. */
  inputPricePerMillion?: string;
  outputPricePerMillion?: string;
  isActive?: boolean;
  isFree?: boolean;
}

export interface UpdateModelPayload {
  name?: string;
  provider?: AiProviderKind;
  externalModelId?: string;
  baseUrl?: string | null;
  apiKey?: string;
  capabilities?: ModelCapability[];
  inputPricePerMillion?: string | null;
  outputPricePerMillion?: string | null;
  isActive?: boolean;
  isFree?: boolean;
}

// ---- Usage & quota ----

/**
 * Response of GET /usage/me. `quota` is null for admins (they bypass quotas);
 * `today.used` excludes failed turns, matching the backend quota count.
 */
export interface UsageSummary {
  plan: UserPlan;
  quota: { dailyMessages: number; dailyTokens: number | null } | null;
  today: { used: number; remaining: number; tokens: number };
}

/** Admin user row (GET /admin/users; PATCH /admin/users/:id/plan response). */
export interface AdminUser {
  id: string;
  email: string;
  role: UserRole;
  plan: UserPlan;
  createdAt: string;
}

export interface UsageSplitRow {
  turns: number;
  tokens: number;
  cost: number;
}

/** Response of GET /admin/usage/summary — consumption & cost overview. */
export interface AdminUsageSummary {
  days: number;
  totals: {
    turns: number;
    failedTurns: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  perDay: (UsageSplitRow & { date: string })[];
  perModel: (UsageSplitRow & {
    modelId: string | null;
    modelName: string | null;
    provider: AiProviderKind | null;
  })[];
  perUser: (UsageSplitRow & { userId: string; email: string })[];
}

export interface SendMessagePayload {
  content: string;
  modelId?: string;
  /**
   * READY files of THIS conversation to use as context. The backend rejects
   * unknown/foreign/not-yet-ready ids with 400 before the stream opens.
   */
  fileIds?: string[];
  /**
   * Client-generated idempotency token (≤ 64 chars). Two requests with the
   * same token for the same conversation reuse the original user row and
   * emit `replay: true` in the meta event. If the same token is reused with
   * different content, the backend rejects with 400.
   *
   * Optional: when omitted, `Idempotency-Key` HTTP header is also accepted
   * by the backend as a fallback.
   */
  clientMessageId?: string;
}
