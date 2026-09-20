import type {
  AdminPayment,
  AdminSubscriptionRow,
  AdminTheme,
  AdminUsageSummary,
  AdminUser,
  AiModel,
  AuditLogEntry,
  AuthResponse,
  AvailableTheme,
  ChatFile,
  CreatePlanPayload,
  Message,
  MessageSource,
  Plan,
  SendMessagePayload,
  SimulateResponse,
  SubscriptionOverview,
  UpdateAdminThemePayload,
  UpdatePlanPayload,
  UsageSummary,
  UserPaymentView,
  UserPlan,
  UserPreferences,
} from './types';

const BASE = 'http://localhost:4000/api';
const TOKEN_KEY = 'hooshyar.token';
const USER_KEY = 'hooshyar.user';

// ---- Token/session helpers (kept here so the API layer owns its transport) ----

export function loadSession(): AuthResponse | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  try {
    const user = JSON.parse(localStorage.getItem(USER_KEY) ?? 'null');
    if (!user?.id) return null;
    return { accessToken: token, user };
  } catch {
    return null;
  }
}

export function saveSession(session: AuthResponse): void {
  localStorage.setItem(TOKEN_KEY, session.accessToken);
  localStorage.setItem(USER_KEY, JSON.stringify(session.user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

let sessionExpiredHandler: (() => void) | null = null;

export function onSessionExpired(handler: () => void): void {
  sessionExpiredHandler = handler;
}

// ---- Core request helper ----

function authHeader(): Record<string, string> {
  const session = loadSession();
  return session ? { Authorization: `Bearer ${session.accessToken}` } : {};
}

function extractError(json: unknown, fallback: string): string {
  const message = (json as { message?: unknown } | null)?.message;
  if (Array.isArray(message)) return message.join(' و ');
  if (typeof message === 'string' && message) return message;
  return fallback;
}

export class ApiError extends Error {}

export async function api<T>(
  path: string,
  { method = 'GET', body }: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 401 && loadSession()) {
    // Session expired or revoked: clear and let the router send us to login.
    clearSession();
    sessionExpiredHandler?.();
    throw new ApiError('نشست شما منقضی شده است. دوباره وارد شوید.');
  }

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    /* empty body (204) */
  }

  if (!response.ok) {
    throw new ApiError(extractError(json, 'خطایی رخ داد. لطفاً دوباره تلاش کنید.'));
  }
  return json as T;
}

// ---- File uploads (Day 5-6) ----

/** Mirrors the backend default; the server remains the source of truth. */
export const MAX_FILE_SIZE_MB = 10;

/** Mirrors the backend's per-message file cap (`FILE_MAX_PER_MESSAGE`). */
export const MAX_FILES_PER_MESSAGE = 6;

/** Extensions the backend accepts (content is still validated server-side). */
export const ACCEPTED_FILE_TYPES =
  '.pdf,.xls,.xlsx,.png,.jpg,.jpeg,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/png,image/jpeg';

/**
 * Uploads one file to a conversation. Uses multipart/form-data, so it cannot
 * go through `api()` (which always sends JSON): the browser must set the
 * boundary itself, and only the Authorization header is added.
 */
export async function uploadConversationFile(
  conversationId: string,
  file: File,
): Promise<ChatFile> {
  const form = new FormData();
  form.append('file', file, file.name);

  let response: Response;
  try {
    response = await fetch(`${BASE}/conversations/${conversationId}/files`, {
      method: 'POST',
      headers: authHeader(),
      body: form,
    });
  } catch {
    throw new ApiError('ارتباط با سرور برقرار نشد. آپلود انجام نشد.');
  }

  if (response.status === 401 && loadSession()) {
    clearSession();
    sessionExpiredHandler?.();
    throw new ApiError('نشست شما منقضی شده است. دوباره وارد شوید.');
  }

  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    /* empty body */
  }

  if (!response.ok) {
    throw new ApiError(extractError(json, 'آپلود فایل ناموفق بود. لطفاً دوباره تلاش کنید.'));
  }
  return json as ChatFile;
}

/** Files of one conversation (statuses only — never the extracted text). */
export function fetchConversationFiles(conversationId: string): Promise<ChatFile[]> {
  return api<ChatFile[]>(`/conversations/${conversationId}/files`);
}

/** Quota/usage snapshot for the signed-in user (null quota = admin). */
export function fetchUsageSummary(): Promise<UsageSummary> {
  return api<UsageSummary>('/usage/me');
}

/** Consumption & cost overview for the admin panel. */
export function fetchAdminUsageSummary(days = 7): Promise<AdminUsageSummary> {
  return api<AdminUsageSummary>(`/admin/usage/summary?days=${days}`);
}

/** All users for the admin panel (no secrets). */
export function fetchAdminUsers(): Promise<AdminUser[]> {
  return api<AdminUser[]>('/admin/users');
}

/** Changes a user's plan; takes effect on that user's next request. */
export function setAdminUserPlan(userId: string, plan: UserPlan): Promise<AdminUser> {
  return api<AdminUser>(`/admin/users/${userId}/plan`, { method: 'PATCH', body: { plan } });
}

// ---- Billing: plans, payments, subscriptions (day 9-10) ----
// The backend resolves every price and entitlement — the UI never sends or
// stores authoritative money/access values.

export function fetchBillingPlans(): Promise<Plan[]> {
  return api<Plan[]>('/billing/plans');
}

export function fetchSubscriptionOverview(): Promise<SubscriptionOverview> {
  return api<SubscriptionOverview>('/billing/subscription/me');
}

export function cancelMySubscription(): Promise<SubscriptionOverview> {
  return api<SubscriptionOverview>('/billing/subscription/cancel', { method: 'POST' });
}

export function fetchMyPayments(): Promise<UserPaymentView[]> {
  return api<UserPaymentView[]>('/billing/payments');
}

/** Starts a checkout for a plan; the server returns a PENDING payment. */
export function createPayment(planId: string): Promise<UserPaymentView> {
  return api<UserPaymentView>('/billing/payments', { method: 'POST', body: { planId } });
}

export function cancelMyPayment(paymentId: string): Promise<UserPaymentView> {
  return api<UserPaymentView>(`/billing/payments/${paymentId}/cancel`, { method: 'POST' });
}

/** MVP gateway simulator: applies a scenario through the real webhook pipeline. */
export function simulatePayment(paymentId: string, scenario: string): Promise<SimulateResponse> {
  return api<SimulateResponse>(`/billing/payments/${paymentId}/simulate`, {
    method: 'POST',
    body: { scenario },
  });
}

export function fetchAdminBillingPlans(): Promise<Plan[]> {
  return api<Plan[]>('/admin/billing/plans');
}

export function createAdminPlan(payload: CreatePlanPayload): Promise<Plan> {
  return api<Plan>('/admin/billing/plans', { method: 'POST', body: payload });
}

export function updateAdminPlan(planId: string, payload: UpdatePlanPayload): Promise<Plan> {
  return api<Plan>(`/admin/billing/plans/${planId}`, { method: 'PATCH', body: payload });
}

export function setAdminPlanActive(planId: string, isActive: boolean): Promise<Plan> {
  return api<Plan>(`/admin/billing/plans/${planId}/${isActive ? 'activate' : 'deactivate'}`, {
    method: 'POST',
  });
}

export function fetchAdminPayments(filters: { userId?: string; status?: string } = {}): Promise<AdminPayment[]> {
  const params = new URLSearchParams();
  if (filters.userId) params.set('userId', filters.userId);
  if (filters.status) params.set('status', filters.status);
  const query = params.toString();
  return api<AdminPayment[]>(`/admin/billing/payments${query ? `?${query}` : ''}`);
}

export function fetchAdminSubscriptions(
  filters: { userId?: string; status?: string } = {},
): Promise<AdminSubscriptionRow[]> {
  const params = new URLSearchParams();
  if (filters.userId) params.set('userId', filters.userId);
  if (filters.status) params.set('status', filters.status);
  const query = params.toString();
  return api<AdminSubscriptionRow[]>(`/admin/billing/subscriptions${query ? `?${query}` : ''}`);
}

export function fetchAdminAuditLogs(
  filters: { eventType?: string; userId?: string } = {},
): Promise<AuditLogEntry[]> {
  const params = new URLSearchParams();
  if (filters.eventType) params.set('eventType', filters.eventType);
  if (filters.userId) params.set('userId', filters.userId);
  const query = params.toString();
  return api<AuditLogEntry[]>(`/admin/billing/audit${query ? `?${query}` : ''}`);
}

// ---- Themes (admin-controlled availability + server-synced preference) ----
// Which themes exist visually is frontend code; WHICH themes users may pick,
// their order and the global default are decided here by the backend.

/** Enabled themes in display order (public — pre-login pages theme too). */
export function fetchAvailableThemes(): Promise<AvailableTheme[]> {
  return api<AvailableTheme[]>('/themes/available');
}

export function fetchMyPreferences(): Promise<UserPreferences> {
  return api<UserPreferences>('/users/me/preferences');
}

/** Persists the theme choice; the server rejects disabled themes (400). */
export function updateMyThemePreference(themeId: string): Promise<UserPreferences> {
  return api<UserPreferences>('/users/me/preferences/theme', {
    method: 'PATCH',
    body: { themeId },
  });
}

export function fetchAdminThemes(): Promise<AdminTheme[]> {
  return api<AdminTheme[]>('/admin/themes');
}

export function updateAdminTheme(
  themeId: string,
  payload: UpdateAdminThemePayload,
): Promise<AdminTheme> {
  return api<AdminTheme>(`/admin/themes/${themeId}`, { method: 'PATCH', body: payload });
}

export function setAdminThemeStatus(themeId: string, enabled: boolean): Promise<AdminTheme> {
  return api<AdminTheme>(`/admin/themes/${themeId}/status`, {
    method: 'PATCH',
    body: { enabled },
  });
}

export function setAdminThemeDefault(themeId: string): Promise<AdminTheme> {
  return api<AdminTheme>(`/admin/themes/${themeId}/default`, { method: 'POST' });
}

/** Full ordered list of theme ids (a complete permutation). */
export function reorderAdminThemes(themeIds: string[]): Promise<AdminTheme[]> {
  return api<AdminTheme[]>('/admin/themes/reorder', {
    method: 'POST',
    body: { themeIds },
  });
}

/** Single file status, used to poll a file until it is READY/FAILED. */
export function fetchChatFile(fileId: string): Promise<ChatFile> {
  return api<ChatFile>(`/files/${fileId}`);
}

/**
 * Downloads the stored bytes of a file the caller owns (thumbnails, previews
 * and downloads). The response is binary, so it bypasses `api()`; the JWT is
 * required because MinIO itself is never exposed to the browser.
 */
export async function fetchFileContent(fileId: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/files/${fileId}/content`, { headers: authHeader() });
  } catch {
    throw new ApiError('دریافت فایل ممکن نشد. ارتباط با سرور برقرار نشد.');
  }

  if (response.status === 401 && loadSession()) {
    clearSession();
    sessionExpiredHandler?.();
    throw new ApiError('نشست شما منقضی شده است. دوباره وارد شوید.');
  }

  if (!response.ok) {
    let message = 'دریافت فایل ممکن نشد.';
    try {
      message = extractError(await response.json(), message);
    } catch {
      /* non-JSON error body — keep the fallback */
    }
    throw new ApiError(message);
  }

  return response.blob();
}

/**
 * Client-side pre-check so an obviously rejected file never costs an upload.
 * The backend stays the source of truth (size, signature and MIME are all
 * re-validated server-side).
 */
export function describeLocalFileProblem(file: File): string | null {
  if (file.size === 0) return 'فایل خالی است و قابل قبول نیست.';
  if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    return `حجم فایل بیش از حد مجاز است (حداکثر ${MAX_FILE_SIZE_MB} مگابایت).`;
  }
  if (!/\.(pdf|xls|xlsx|png|jpe?g)$/i.test(file.name)) {
    return 'فقط فایل PDF، Excel و تصویر (PNG/JPEG) قابل پیوست است.';
  }
  return null;
}

// ---- SSE streaming (fetch + ReadableStream; EventSource cannot POST with JWT) ----

export interface StreamMetaPayload {
  /** The persisted user row (existing or freshly created). */
  userMessage: Message;
  /**
   * The assistant row, pre-persisted with status='pending' BEFORE the first
   * delta. Its id is real and stable — a reload mid-stream can address it.
   */
  assistantMessage: Message;
  model: AiModel;
  /**
   * true when this is a retry of a previous send (same clientMessageId).
   * The user row was reused; a fresh assistant row is being streamed.
   */
  replay: boolean;
  /**
   * true when the SERVER decided the web-search phase is active for this
   * turn (capability + plan + global switch all satisfied) — the client
   * flag alone is never proof a search will run.
   */
  webSearch: boolean;
}

export interface SearchCompletedPayload {
  resultCount: number;
  /** Safe degrade notice (null when the answer uses web context). */
  warning: string | null;
}

/**
 * Execution-phase narration (day-7-8 contract §10/§11) — safe status labels
 * about the system's own work, never chain-of-thought. `detail: 'fallback'`
 * marks the single-hop provider switch.
 */
export interface StreamStatusPayload {
  status: 'thinking' | 'generating';
  detail?: string;
}

/** The turn's web-search citations, streamed once before the first delta. */
export interface StreamSourcesPayload {
  sources: MessageSource[];
}

export interface StreamEvents {
  onMeta: (payload: StreamMetaPayload) => void;
  /** Execution phase changed (thinking → generating; detail='fallback'). */
  onStatus?: (payload: StreamStatusPayload) => void;
  /** Web-search turn: the live search began (show "searching…"). */
  onSearchStarted?: () => void;
  /** Web-search turn: search finished — show count or the degrade warning. */
  onSearchCompleted?: (payload: SearchCompletedPayload) => void;
  /** Web-search turn: the citations arrived (render before the first delta). */
  onSources?: (payload: StreamSourcesPayload) => void;
  onDelta: (payload: { text: string }) => void;
  onDone: (payload: { assistantMessage: Message }) => void;
  onError: (message: string) => void;
}

export type StreamHandle = { abort: () => void };

export function streamChatMessage(
  conversationId: string,
  payload: SendMessagePayload,
  events: StreamEvents,
): StreamHandle {
  const controller = new AbortController();

  void (async () => {
    let response: Response;
    try {
      // The backend reads clientMessageId from the body, OR from an
      // Idempotency-Key header (defense-in-depth: proxies / replay logs).
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeader(),
      };
      if (payload.clientMessageId && !headers['Idempotency-Key']) {
        headers['Idempotency-Key'] = payload.clientMessageId;
      }
      response = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      if (!controller.signal.aborted) {
        events.onError('ارتباط با سرور برقرار نشد. لطفاً دوباره تلاش کنید.');
      }
      return;
    }

    if (!response.ok || !response.body) {
      let message = 'خطایی رخ داد. لطفاً دوباره تلاش کنید.';
      try {
        message = extractError(await response.json(), message);
      } catch {
        /* keep fallback */
      }
      events.onError(message);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const dispatch = (block: string) => {
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) return;
      try {
        const parsed: unknown = JSON.parse(data);
        if (event === 'meta') events.onMeta(parsed as StreamMetaPayload);
        else if (event === 'status')
          events.onStatus?.(parsed as StreamStatusPayload);
        else if (event === 'search_started') events.onSearchStarted?.();
        else if (event === 'search_completed')
          events.onSearchCompleted?.(parsed as SearchCompletedPayload);
        else if (event === 'sources')
          events.onSources?.(parsed as StreamSourcesPayload);
        else if (event === 'delta') events.onDelta(parsed as { text: string });
        else if (event === 'done') events.onDone(parsed as { assistantMessage: Message });
        // Terminal failure is emitted as `failed` by the backend; `error` is
        // kept as a defensive fallback for older payloads.
        else if (event === 'failed' || event === 'error')
          events.onError(String((parsed as { message?: unknown })?.message ?? 'خطا'));
      } catch {
        /* ignore malformed keep-alive lines */
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf('\n\n');
        while (separator !== -1) {
          dispatch(buffer.slice(0, separator));
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf('\n\n');
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        events.onError('ارتباط هنگام دریافت پاسخ قطع شد.');
      }
    }
  })();

  return { abort: () => controller.abort() };
}

// ---- Reconnect / recovery stream (refresh, new tab, restored network) ----

export interface ReconnectEvents {
  /** Full content accumulated so far — REPLACE, never append. */
  onSnapshot: (assistantMessage: Message) => void;
  /** Live execution-phase narration (only for phases after attaching). */
  onStatus?: (payload: StreamStatusPayload) => void;
  /** Live citations event for a subscriber that attached mid-search. */
  onSources?: (payload: StreamSourcesPayload) => void;
  onDelta: (payload: { text: string }) => void;
  onDone: (assistantMessage: Message) => void;
  /**
   * Terminal failure (generation failed, or was orphaned by a server
   * restart and honestly marked interrupted). `assistantMessage` is the
   * persisted row; `message` is a safe user-facing string.
   */
  onFailed: (assistantMessage: Message | null, message: string) => void;
}

export function reconnectGenerationStream(
  conversationId: string,
  messageId: string,
  events: ReconnectEvents,
): StreamHandle {
  const controller = new AbortController();

  void (async () => {
    let response: Response;
    try {
      response = await fetch(
        `${BASE}/conversations/${conversationId}/messages/${messageId}/stream`,
        { headers: authHeader(), signal: controller.signal },
      );
    } catch {
      if (!controller.signal.aborted) {
        events.onFailed(null, 'ارتباط با سرور برقرار نشد.');
      }
      return;
    }

    if (response.status === 404) {
      // Unknown/foreign message — nothing to recover.
      events.onFailed(null, 'پیام قابل بازیابی نیست.');
      return;
    }
    if (!response.ok || !response.body) {
      events.onFailed(null, 'بازیابی پاسخ ممکن نشد.');
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const dispatch = (block: string) => {
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) return;
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (event === 'snapshot') {
          events.onSnapshot(parsed.assistantMessage as Message);
        } else if (event === 'status') {
          events.onStatus?.(parsed as unknown as StreamStatusPayload);
        } else if (event === 'sources') {
          events.onSources?.(parsed as unknown as StreamSourcesPayload);
        } else if (event === 'delta') {
          events.onDelta(parsed as { text: string });
        } else if (event === 'done') {
          events.onDone(parsed.assistantMessage as Message);
        } else if (event === 'failed') {
          events.onFailed(
            (parsed.assistantMessage as Message | null) ?? null,
            String(parsed.message ?? 'بازیابی پاسخ ممکن نشد.'),
          );
        }
      } catch {
        /* ignore malformed keep-alive lines */
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator = buffer.indexOf('\n\n');
        while (separator !== -1) {
          dispatch(buffer.slice(0, separator));
          buffer = buffer.slice(separator + 2);
          separator = buffer.indexOf('\n\n');
        }
      }
    } catch {
      if (!controller.signal.aborted) {
        events.onFailed(null, 'ارتباط هنگام بازیابی پاسخ قطع شد.');
      }
    }
  })();

  return { abort: () => controller.abort() };
}
