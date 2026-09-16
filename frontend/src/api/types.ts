/** API contract types — mirror the backend entities (see docs/API.md). */

export type UserRole = 'user' | 'admin';

export interface User {
  id: string;
  email: string;
  role: UserRole;
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

export type AiProviderKind = 'mock' | 'openai-compatible';

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
  createdAt: string;
  hasApiKey: boolean;
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

export interface CreateModelPayload {
  name: string;
  provider: AiProviderKind;
  externalModelId: string;
  baseUrl?: string;
  apiKey?: string;
  isActive?: boolean;
  isFree?: boolean;
}

export interface UpdateModelPayload {
  name?: string;
  provider?: AiProviderKind;
  externalModelId?: string;
  baseUrl?: string | null;
  apiKey?: string;
  isActive?: boolean;
  isFree?: boolean;
}
