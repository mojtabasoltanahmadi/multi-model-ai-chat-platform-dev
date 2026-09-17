<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppSidebar from '../components/layout/AppSidebar.vue';
import ChatHeader from '../components/chat/ChatHeader.vue';
import EmptyChat from '../components/chat/EmptyChat.vue';
import MessageItem from '../components/chat/MessageItem.vue';
import MessageComposer from '../components/chat/MessageComposer.vue';
import FileViewerModal from '../components/chat/FileViewerModal.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import {
  api,
  describeLocalFileProblem,
  MAX_FILES_PER_MESSAGE,
  fetchChatFile,
  fetchConversationFiles,
  fetchFileContent,
  streamChatMessage,
  reconnectGenerationStream,
  uploadConversationFile,
  type StreamHandle,
} from '../api/client';
import type { AiModel, ChatFile, Conversation, Message } from '../api/types';
import { isImageFile } from '../utils/fileKind';
import { useToast } from '../composables/useToast';
import { useOnline } from '../composables/useOnline';

const toast = useToast();
const { online } = useOnline();

// ---- data ----
const conversations = ref<Conversation[]>([]);
const conversationsLoading = ref(true);
const activeId = ref<string | null>(readActiveConversationPreference());
const messages = ref<Message[]>([]);
const messagesLoading = ref(false);
const models = ref<AiModel[]>([]);
const selectedModelId = ref('');
const drawerOpen = ref(false);
const error = ref('');

/**
 * File attachments (Day 5-6).
 *  - `attachments` are files waiting to be sent as context (composer chips).
 *  - `filesById` is the conversation's file index, which resolves the ids
 *    stored on historical user messages so a reload still renders them.
 * Uploading is asynchronous: the response comes back UPLOADING/PROCESSING and
 * the status is polled until READY/FAILED, while chat stays fully usable.
 */
const attachments = ref<ChatFile[]>([]);
const filesById = ref<Record<string, ChatFile>>({});
/** Files currently being uploaded by THIS tab (they cannot be sent yet). */
const uploadingCount = ref(0);
/** Object URLs for image thumbnails, keyed by file id (local or server). */
const previews = ref<Record<string, string>>({});
/** In-flight thumbnail fetches, so a chip never triggers two downloads. */
const previewFetches = new Map<string, Promise<void>>();
/** File opened in the viewer modal (null = closed). */
const viewerFile = ref<ChatFile | null>(null);
let attachmentPoller: number | null = null;

/**
 * Text used when the user sends files without writing anything. The backend
 * requires non-blank content, and an empty prompt would give the model nothing
 * to act on, so a neutral instruction stands in for the missing draft.
 */
function defaultFilePrompt(fileCount: number): string {
  return fileCount > 1 ? 'این فایل‌ها را بررسی کن.' : 'این فایل را بررسی کن.';
}

/** Desktop collapse state (ChatGPT-style rail); persisted per machine. */
const sidebarCollapsed = ref(readCollapsedPreference());

function readCollapsedPreference(): boolean {
  try {
    // Strict comparison: any invalid stored value falls back to expanded.
    return localStorage.getItem('hooshyar.sidebar-collapsed') === 'true';
  } catch {
    return false;
  }
}

watch(sidebarCollapsed, (value) => {
  try {
    localStorage.setItem('hooshyar.sidebar-collapsed', String(value));
  } catch {
    /* storage unavailable (private mode) — keep state in memory only */
  }
});

/** Last-opened conversation id; restored on refresh so the user lands back where they were. */
const ACTIVE_CONV_KEY = 'hooshyar.active-conversation';
function readActiveConversationPreference(): string | null {
  try {
    const value = localStorage.getItem(ACTIVE_CONV_KEY);
    return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}
watch(activeId, (value) => {
  try {
    if (value) localStorage.setItem(ACTIVE_CONV_KEY, value);
    else localStorage.removeItem(ACTIVE_CONV_KEY);
  } catch {
    /* private mode — keep state in memory only */
  }
});

// streaming placeholder id inside the messages list (optimistic send only)
const STREAM_ID = '__streaming__';
const streaming = ref(false);
const streamHandle = ref<StreamHandle | null>(null);
/**
 * The message row currently being streamed into — either the optimistic
 * placeholder of a fresh send, or a persisted row being recovered via the
 * reconnect stream (refresh / new tab / restored network).
 */
const activeStreamRowId = ref<string | null>(null);
/**
 * clientMessageId of the in-flight send. Stored so a stop/abort/error path
 * can recover: the backend already persisted the user row with this id, so
 * the next refresh reads it back without losing the user's intent.
 */
const inflightClientMessageId = ref<string | null>(null);
/**
 * Assistant row whose live feed a transport drop severed in THIS session
 * (rendered locally as 'interrupted'). When connectivity returns, the
 * online-watcher re-attaches it to the still-running generation. A deliberate
 * Stop never sets this — a stopped turn stays stopped until the user retries.
 */
const networkRecoveryRowId = ref<string | null>(null);

const completedMessages = computed(() =>
  messages.value.filter((message) => message.id !== activeStreamRowId.value),
);
const streamingMessage = computed(
  () => messages.value.find((message) => message.id === activeStreamRowId.value) ?? null,
);
const activeConversation = computed(
  () => conversations.value.find((conversation) => conversation.id === activeId.value) ?? null,
);
const activeModel = computed(
  () => models.value.find((model) => model.id === selectedModelId.value) ?? null,
);

onMounted(async () => {
  await Promise.all([loadConversations(), loadModels()]);
  // Restore the last-opened conversation if it still belongs to the user.
  if (activeId.value && conversations.value.some((c) => c.id === activeId.value)) {
    await loadMessages();
  } else {
    activeId.value = null;
  }
});

onBeforeUnmount(() => {
  stopAttachmentPolling();
  releasePreviews();
});

// Connectivity returned: re-attach any row whose live feed a transport drop
// severed this session (internet disconnect mid-stream). The generation kept
// running server-side, so the reconnect stream hands back a snapshot plus the
// remaining deltas — no AI re-invocation, no duplicated tokens.
watch(online, (isOnline) => {
  if (!isOnline || streaming.value || messagesLoading.value) return;
  const rowId = networkRecoveryRowId.value;
  if (!rowId) return;
  networkRecoveryRowId.value = null;
  const row = messages.value.find((m) => m.id === rowId);
  if (row && (row.status === 'interrupted' || row.status === 'streaming')) {
    void recoverGeneration(row);
  }
});

async function loadConversations() {
  conversationsLoading.value = true;
  try {
    conversations.value = await api<Conversation[]>('/conversations');
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'خطا';
  } finally {
    conversationsLoading.value = false;
  }
}

async function loadModels() {
  try {
    models.value = await api<AiModel[]>('/models');
    const fallback = models.value.find((model) => model.isDefault) ?? models.value[0];
    if (fallback) selectedModelId.value = fallback.id;
  } catch {
    models.value = [];
  }
}

// ---- conversations ----
async function selectConversation(id: string) {
  if (id === activeId.value || streaming.value) return;
  activeId.value = id;
  error.value = '';
  await loadMessages();
}

async function createConversation(): Promise<Conversation> {
  const conversation = await api<Conversation>('/conversations', { method: 'POST', body: {} });
  conversations.value.unshift(conversation);
  activeId.value = conversation.id;
  messages.value = [];
  return conversation;
}

async function loadMessages() {
  if (!activeId.value) {
    messages.value = [];
    attachments.value = [];
    filesById.value = {};
    releasePreviews();
    stopAttachmentPolling();
    return;
  }
  messagesLoading.value = true;
  // Files are loaded with the conversation so a refresh restores in-flight
  // processing state (it is persisted server-side, never only in memory).
  void loadConversationFiles();
  try {
    const result = await api<{ conversation: Conversation; messages: Message[] }>(
      `/conversations/${activeId.value}`,
    );
    messages.value = result.messages;
    await scrollToBottom(true);

    // Recovery: an assistant row still pending/streaming means a generation
    // is (or was) running server-side — re-attach instead of regenerating.
    // Latest unfinished row only; completed/failed/interrupted rows load as-is.
    const recoverable = [...result.messages]
      .reverse()
      .find(
        (m) =>
          m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming'),
      );
    if (recoverable) void recoverGeneration(recoverable);
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'خطا';
  } finally {
    messagesLoading.value = false;
  }
}

function startNewConversation() {
  if (streaming.value) return;
  activeId.value = null;
  messages.value = [];
  attachments.value = [];
  viewerFile.value = null;
  releasePreviews();
}

// ---- file attachments ----

/** Indexes the conversation's files and resumes polling for unfinished ones. */
async function loadConversationFiles() {
  const conversationId = activeId.value;
  if (!conversationId) return;
  try {
    const files = await fetchConversationFiles(conversationId);
    if (conversationId !== activeId.value) return; // switched meanwhile
    indexFiles(files);

    // Restore unfinished uploads as composer chips so the user still sees the
    // file that was processing when the page was reloaded (status came from
    // the database, not from memory). READY files were already consumed by
    // their message and are only used to label those chips.
    const unfinished = files.filter(
      (file) => file.status !== 'READY' && !attachments.value.some((a) => a.id === file.id),
    );
    attachments.value = [...attachments.value, ...unfinished];
    ensureAttachmentPolling();
  } catch {
    /* the file index is a convenience — chat still works without it */
  }
}

function indexFiles(files: ChatFile[]) {
  const index = { ...filesById.value };
  for (const file of files) index[file.id] = file;
  filesById.value = index;
}

/** Files attached to a specific user message, resolved for chip rendering. */
function attachmentsFor(message: Message): ChatFile[] {
  if (!message.attachedFileIds?.length) return [];
  return message.attachedFileIds
    .map((id) => filesById.value[id])
    .filter((file): file is ChatFile => Boolean(file));
}

/**
 * Uploads one or more files chosen in a single picker session. Every accepted
 * file shows up as a chip (with an image thumbnail) immediately, so the upload
 * is visible while it runs, and the Send button stays disabled until the last
 * transfer finishes. Processing afterwards does NOT block chat.
 */
async function attachFiles(files: File[]) {
  error.value = '';
  if (files.length === 0) return;

  // Obvious rejects never cost an upload; the backend re-validates everything.
  const valid: File[] = [];
  for (const file of files) {
    const problem = describeLocalFileProblem(file);
    if (problem) toast.error(`«${file.name}»: ${problem}`);
    else valid.push(file);
  }
  if (valid.length === 0) return;

  // Per-message cap, enforced before anything leaves the browser (the backend
  // rejects an oversized fileIds array anyway, so failing early is clearer).
  const remaining = MAX_FILES_PER_MESSAGE - attachments.value.length;
  if (remaining <= 0) {
    toast.error(`حداکثر ${MAX_FILES_PER_MESSAGE.toLocaleString('fa-IR')} فایل می‌توانید اضافه کنید.`);
    return;
  }
  if (valid.length > remaining) {
    toast.error(
      `فقط ${remaining.toLocaleString('fa-IR')} فایل دیگر می‌توانید اضافه کنید.`,
    );
    valid.length = remaining;
  }

  try {
    if (!activeId.value) await createConversation();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'ساخت گفتگو ناموفق بود.');
    return;
  }
  const conversationId = activeId.value;
  if (!conversationId) return;

  // Local placeholders: the server id is not known until the upload returns.
  const pending = valid.map((file) => makePendingAttachment(file, conversationId));
  valid.forEach((file, index) => {
    if (isImageFile({ originalName: file.name, mimeType: file.type })) {
      previews.value = { ...previews.value, [pending[index].id]: URL.createObjectURL(file) };
    }
  });
  attachments.value = [...attachments.value, ...pending];
  uploadingCount.value += pending.length;

  await Promise.allSettled(
    valid.map(async (file, index) => {
      const placeholder = pending[index];
      try {
        const uploaded = await uploadConversationFile(conversationId, file);
        if (conversationId !== activeId.value) {
          // The user moved on; the file is uploaded but no longer on screen.
          revokePreview(placeholder.id);
          return;
        }
        indexFiles([uploaded]);
        adoptPreview(placeholder.id, uploaded.id);
        attachments.value = attachments.value.map((item) =>
          item.id === placeholder.id ? uploaded : item,
        );
        ensureAttachmentPolling();
      } catch (e) {
        removeAttachment(placeholder.id);
        toast.error(e instanceof Error ? e.message : 'آپلود فایل ناموفق بود.');
      } finally {
        uploadingCount.value = Math.max(0, uploadingCount.value - 1);
      }
    }),
  );
}

function makePendingAttachment(file: File, conversationId: string): ChatFile {
  const now = new Date().toISOString();
  return {
    id: `local-${localId()}`,
    userId: '',
    conversationId,
    originalName: file.name || 'بدون‌نام',
    mimeType: file.type,
    size: file.size,
    status: 'UPLOADING',
    errorMessage: null,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function localId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function removeAttachment(fileId: string) {
  attachments.value = attachments.value.filter((file) => file.id !== fileId);
  revokePreview(fileId);
  ensureAttachmentPolling();
}

// ---- thumbnails & viewer ----

/** Object URL for a file's thumbnail, when one has been loaded already. */
function previewFor(fileId: string): string | null {
  return previews.value[fileId] ?? null;
}

/** Moves a local placeholder's thumbnail onto the server-assigned file id. */
function adoptPreview(fromId: string, toId: string) {
  const current = previews.value[fromId];
  if (!current) return;
  const next = { ...previews.value, [toId]: current };
  delete next[fromId];
  previews.value = next;
}

function revokePreview(fileId: string) {
  const url = previews.value[fileId];
  if (!url) return;
  URL.revokeObjectURL(url);
  const next = { ...previews.value };
  delete next[fileId];
  previews.value = next;
}

function releasePreviews() {
  for (const url of Object.values(previews.value)) URL.revokeObjectURL(url);
  previews.value = {};
  previewFetches.clear();
}

/**
 * Lazily fetches a thumbnail for an image that came from the server (sent in an
 * earlier turn, or uploaded before a refresh). A thumbnail is a nicety: a
 * failure leaves the static kind icon in place.
 */
async function ensureImagePreview(file: ChatFile) {
  if (file.status !== 'READY' || !isImageFile(file)) return;
  if (previews.value[file.id] || previewFetches.has(file.id)) return;
  const task = (async () => {
    try {
      const blob = await fetchFileContent(file.id);
      previews.value = { ...previews.value, [file.id]: URL.createObjectURL(blob) };
    } catch {
      /* keep the icon fallback */
    } finally {
      previewFetches.delete(file.id);
    }
  })();
  previewFetches.set(file.id, task);
  await task;
}

/**
 * Opens the preview sheet for a file. Only `READY` files have content to show,
 * so anything else answers with the reason instead of an empty viewer.
 */
function openFile(file: ChatFile) {
  if (file.status !== 'READY') {
    toast.error(`«${file.originalName}» هنوز آماده نیست.`);
    return;
  }
  viewerFile.value = file;
  void ensureImagePreview(file);
}

/** Polls only while something is still being processed. */
function ensureAttachmentPolling() {
  const hasUnfinished = attachments.value.some(
    (file) => file.status === 'UPLOADING' || file.status === 'PROCESSING',
  );
  if (hasUnfinished && attachmentPoller === null) {
    attachmentPoller = window.setInterval(() => void refreshAttachments(), 2500);
  } else if (!hasUnfinished) {
    stopAttachmentPolling();
  }
}

function stopAttachmentPolling() {
  if (attachmentPoller !== null) window.clearInterval(attachmentPoller);
  attachmentPoller = null;
}

/**
 * Re-reads the status of attached files. A single failed poll (offline blip)
 * is ignored: the next tick retries, and the state lives in the database.
 */
async function refreshAttachments() {
  const pending = attachments.value.filter(
    (file) => file.status === 'UPLOADING' || file.status === 'PROCESSING',
  );
  if (pending.length === 0) {
    stopAttachmentPolling();
    return;
  }
  const updated = await Promise.all(
    pending.map(async (file) => {
      try {
        return await fetchChatFile(file.id);
      } catch {
        return null;
      }
    }),
  );
  const changed = updated.filter((file): file is ChatFile => Boolean(file));
  if (changed.length > 0) {
    indexFiles(changed);
    attachments.value = attachments.value.map(
      (file) => changed.find((updatedFile) => updatedFile.id === file.id) ?? file,
    );
    for (const file of changed) {
      if (file.status === 'FAILED') {
        toast.error(`پردازش «${file.originalName}» ناموفق بود.`);
      }
    }
  }
  ensureAttachmentPolling();
}

// ---- sending / streaming ----
/**
 * Generates a client-side idempotency token. Format: `<prefix>-<base36 ts>-<rand>`.
 * Stays under the 64-char backend limit, is sortable by creation time, and the
 * random suffix prevents accidental collisions if a refresh fires a send within
 * the same millisecond.
 */
function newClientMessageId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff).toString(36).padStart(4, '0');
  return `cm-${ts}-${rand}`;
}

async function send(
  content: string,
  options: { clientMessageId?: string; existingUserRowId?: string; fileIds?: string[] } = {},
) {
  if (streaming.value) return;
  error.value = '';

  try {
    if (!activeId.value) await createConversation();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'ساخت گفتگو ناموفق بود.';
    return;
  }

  const conversationId = activeId.value;
  if (!conversationId) return;

  // Reuse the same id when this is a Retry of a previous turn; generate a
  // fresh one otherwise. The backend treats a matching id + matching content
  // as a replay (same user row, new assistant row).
  const clientMessageId = options.clientMessageId ?? newClientMessageId();
  inflightClientMessageId.value = clientMessageId;
  // A new send supersedes any pending network-recovery attachment.
  networkRecoveryRowId.value = null;

  // Only READY files may be sent as context; anything still processing stays
  // attached for the next message (the backend re-checks and would 400).
  const fileIds =
    options.fileIds ??
    attachments.value.filter((file) => file.status === 'READY').map((file) => file.id);

  // A file on its own is a complete message — no text required.
  const messageContent =
    content.trim() || (fileIds.length > 0 ? defaultFilePrompt(fileIds.length) : '');
  if (!messageContent) return;

  const optimisticUser: Message = {
    id: `local-${clientMessageId}`,
    conversationId,
    role: 'user',
    content: messageContent,
    status: null,
    errorMessage: null,
    modelId: null,
    clientMessageId,
    // Files used for this turn, so the chips show immediately (the persisted
    // row returns the same ids via the meta event).
    attachedFileIds: fileIds.length > 0 ? fileIds : null,
    createdAt: new Date().toISOString(),
  };
  const placeholder: Message = {
    id: STREAM_ID,
    conversationId,
    role: 'assistant',
    content: '',
    status: 'pending',
    errorMessage: null,
    modelId: null,
    clientMessageId: null,
    attachedFileIds: null,
    createdAt: new Date().toISOString(),
  };
  // A retry (manual or auto) reuses the user row already on screen — pushing
  // the optimistic copy again would render the same message twice.
  if (options.existingUserRowId) messages.value.push(placeholder);
  else messages.value.push(optimisticUser, placeholder);
  // Stream deltas must mutate the row through the array's reactive proxy.
  // Writing to the raw `placeholder` literal bypasses Vue's proxy, so the
  // template would never re-render until some unrelated state change.
  const streamingRow = messages.value[messages.value.length - 1] as Message;
  streaming.value = true;
  activeStreamRowId.value = STREAM_ID;
  pinnedToBottom.value = true;
  await scrollToBottom();

  let accumulated = '';
  const finish = () => {
    streaming.value = false;
    streamHandle.value = null;
    activeStreamRowId.value = null;
    inflightClientMessageId.value = null;
    // Sent files are now part of the message; only unfinished ones stay
    // attached for the next turn.
    if (fileIds.length > 0) {
      attachments.value = attachments.value.filter((file) => file.status !== 'READY');
      ensureAttachmentPolling();
    }
    void loadConversations(); // refresh titles and ordering
  };

  streamHandle.value = streamChatMessage(
    conversationId,
    {
      content: messageContent,
      modelId: selectedModelId.value || undefined,
      clientMessageId,
      fileIds,
    },
    {
      onMeta: (meta) => {
        const optimistic = messages.value.find((m) => m.id === optimisticUser.id);
        if (optimistic) Object.assign(optimistic, meta.userMessage);
        // The pre-persisted assistant row replaces the optimistic placeholder:
        // its id is real, its status is 'pending' (server flips it on first delta).
        streamingRow.id = meta.assistantMessage.id;
        streamingRow.status = 'streaming';
        streamingRow.modelId = meta.assistantMessage.modelId ?? meta.model.id;
      },
      onDelta: ({ text }) => {
        accumulated += text;
        streamingRow.content = accumulated;
        streamingRow.status = 'streaming';
        void scrollToBottom();
      },
      onDone: ({ assistantMessage }) => {
        // Promote the placeholder to the persisted message (real id/content).
        Object.assign(streamingRow, assistantMessage);
        finish();
      },
      onError: (message) => {
        if (accumulated.length > 0) {
          // The live feed dropped AFTER deltas arrived (network loss, or the
          // provider died mid-flight). The generation keeps running and
          // persisting server-side — disconnect ≠ failure. Keep every token
          // already delivered, mark the view honestly detached, and let the
          // online-watcher re-attach to the same generation when the network
          // returns. Never fabricate a failed row here.
          streamingRow.content = accumulated;
          streamingRow.status = 'interrupted';
          networkRecoveryRowId.value = streamingRow.id;
          toast.error(message);
        } else {
          // Failed before any delta: the backend has persisted the turn's
          // real state (or the request never landed). Reload instead of
          // fabricating a row — the DB is the source of truth.
          toast.error(message);
          void loadMessages();
        }
        finish();
      },
    },
  );
}

/**
 * Recovery path: a persisted assistant row is still pending/streaming after a
 * conversation load (refresh mid-stream, new tab, restored network). Attach
 * to the live generation via the reconnect stream: the snapshot REPLACES the
 * row content, subsequent deltas APPEND — the backend guarantees the two
 * never overlap, so no token is duplicated and the answer completes from the
 * generation that is already running server-side. The AI is never re-invoked.
 */
function recoverGeneration(row: Message) {
  if (streaming.value) return;
  const conversationId = activeId.value;
  if (!conversationId) return;
  const reactiveRow = messages.value.find((m) => m.id === row.id);
  if (!reactiveRow) return;

  streaming.value = true;
  activeStreamRowId.value = row.id;
  pinnedToBottom.value = true;

  const finish = () => {
    streaming.value = false;
    streamHandle.value = null;
    activeStreamRowId.value = null;
    void loadConversations();
  };

  streamHandle.value = reconnectGenerationStream(conversationId, row.id, {
    onSnapshot: (assistantMessage) => {
      Object.assign(reactiveRow, assistantMessage);
      void scrollToBottom(true);
    },
    onDelta: ({ text }) => {
      reactiveRow.content += text;
      reactiveRow.status = 'streaming';
      void scrollToBottom();
    },
    onDone: (assistantMessage) => {
      Object.assign(reactiveRow, assistantMessage);
      finish();
    },
    onFailed: (assistantMessage, message) => {
      if (assistantMessage) {
        // Orphaned (server restart) or failed generation — the row carries
        // the honest terminal state from the DB.
        Object.assign(reactiveRow, assistantMessage);
      } else {
        // Network-level failure while reconnecting — keep the partial row
        // visible and remember it: when connectivity returns the
        // online-watcher re-attaches to the same generation.
        reactiveRow.status = 'interrupted';
        networkRecoveryRowId.value = reactiveRow.id;
      }
      toast.error(message);
      finish();
    },
  });
}

/** Retry a non-terminal assistant row by re-sending its user prompt with the same id. */
function retry(message: Message) {
  if (streaming.value) return;
  if (message.role !== 'assistant') return;
  if (message.status !== 'failed' && message.status !== 'interrupted') return;

  // Find the user row immediately preceding this assistant row (chronologically).
  const index = messages.value.findIndex((m) => m.id === message.id);
  if (index <= 0) return;
  const userRow = messages.value
    .slice(0, index)
    .reverse()
    .find((m) => m.role === 'user');
  if (!userRow?.content) return;

  // Remove the failed/interrupted assistant row so the optimistic stream
  // doesn't double the visible assistant bubble for this turn.
  messages.value.splice(index, 1);

  // The original user row already carries its clientMessageId (persisted).
  // Reusing it lets the backend recognise this as a replay and produce a
  // fresh assistant row without duplicating the user row.
  // The user row stays on screen (existingUserRowId suppresses the optimistic
  // duplicate); reusing its clientMessageId makes the backend treat this as a
  // replay — one user row, one fresh assistant row.
  // The turn's own attachments, not the composer's pending files: retrying a
  // failed answer must not quietly drop the files it was asked about.
  void send(userRow.content, {
    clientMessageId: userRow.clientMessageId ?? undefined,
    existingUserRowId: userRow.id,
    fileIds: userRow.attachedFileIds ?? [],
  });
}

function stopStreaming() {
  streamHandle.value?.abort();
  // Aborting only detaches THIS view from the live stream — the generation
  // keeps running server-side and its full answer is persisted. The row is
  // shown locally as detached; the next load of this conversation reads the
  // final state from the database (or re-attaches if still generating).
  const row = streamingMessage.value;
  if (row) {
    row.status = 'interrupted';
    row.errorMessage = null;
  }
  streaming.value = false;
  streamHandle.value = null;
  activeStreamRowId.value = null;
  inflightClientMessageId.value = null;
  void loadConversations();
}

// ---- scrolling: never yank the user back up ----
const scroller = ref<HTMLElement | null>(null);
const pinnedToBottom = ref(true);

function onScroll() {
  const element = scroller.value;
  if (!element) return;
  pinnedToBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
}

async function scrollToBottom(force = false) {
  await nextTick();
  const element = scroller.value;
  if (element && (force || pinnedToBottom.value)) element.scrollTop = element.scrollHeight;
}
</script>

<template>
  <div class="chat-page">
    <Transition name="fade">
      <div v-if="drawerOpen" class="chat-page__overlay" @click="drawerOpen = false"></div>
    </Transition>

    <AppSidebar
      :conversations="conversations"
      :active-id="activeId"
      :loading="conversationsLoading"
      :open="drawerOpen"
      :collapsed="sidebarCollapsed"
      @select="selectConversation"
      @create="startNewConversation"
      @close="drawerOpen = false"
      @toggle-collapse="sidebarCollapsed = !sidebarCollapsed"
    />

    <main class="chat">
      <ChatHeader
        :title="activeConversation?.title ?? 'گفتگوی تازه'"
        :models="models"
        :model-id="selectedModelId"
        @update:model-id="selectedModelId = $event"
        @open-menu="drawerOpen = true"
      />

      <Transition name="slide-down">
        <div v-if="!online" class="chat__offline-banner" role="status" aria-live="polite">
          <span class="chat__offline-dot" aria-hidden="true"></span>
          ارتباط اینترنت قطع است. پیام‌های در حال ارسال پس از برقراری دوباره قابل بازیابی هستند.
        </div>
      </Transition>

      <div ref="scroller" class="chat__messages" @scroll.passive="onScroll">
        <EmptyChat v-if="!activeId && !conversationsLoading" @pick="send" />

        <div v-else-if="messagesLoading" class="chat__loading" aria-label="در حال بارگذاری پیام‌ها">
          <div v-for="row in 3" :key="row" class="chat__loading-row">
            <AppSkeleton :lines="2" :width="row % 2 ? '60%' : '40%'" />
          </div>
        </div>

        <div v-else class="chat__stream">
          <MessageItem
            v-for="message in completedMessages"
            :key="message.id"
            :message="message"
            :model-name="models.find((m) => m.id === message.modelId)?.name"
            :retry-disabled="streaming"
            :attachments="attachmentsFor(message)"
            :previews="previews"
            :request-preview="ensureImagePreview"
            @retry="retry"
            @open-file="openFile"
          />
          <MessageItem
            v-if="streamingMessage"
            :message="streamingMessage"
            :model-name="activeModel?.name"
            streaming
          />
        </div>
      </div>

      <MessageComposer
        :models="models"
        :model-id="selectedModelId"
        :streaming="streaming"
        :attachments="attachments"
        :uploading-count="uploadingCount"
        :previews="previews"
        :request-preview="ensureImagePreview"
        :hint="activeId ? '' : 'ارسال اولین پیام، گفتگو را به‌صورت خودکار می‌سازد.'"
        @send="send"
        @stop="stopStreaming"
        @attach="attachFiles"
        @remove-attachment="removeAttachment"
        @open-file="openFile"
        @update:model-id="selectedModelId = $event"
      />

      <FileViewerModal
        v-if="viewerFile"
        :file="viewerFile"
        :preview-url="previewFor(viewerFile.id)"
        @close="viewerFile = null"
      />
    </main>
  </div>
</template>

<style scoped>
.chat-page {
  display: flex;
  height: 100dvh;
  overflow: hidden;
}

.chat-page__overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-drawer-overlay);
  background: color-mix(in srgb, var(--text-1) 30%, transparent);
}

.chat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}

.chat__messages {
  flex: 1;
  overflow-y: auto;
  padding: 1.6rem 1.5rem;
}

.chat__offline-banner {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.55rem 1.2rem;
  font-size: 0.78rem;
  color: var(--text-2);
  background: color-mix(in srgb, var(--danger) 8%, var(--surface));
  border-bottom: 1px solid color-mix(in srgb, var(--danger) 18%, transparent);
}

.chat__offline-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  background: var(--danger);
  animation: offline-pulse 1.6s ease-in-out infinite;
}

@keyframes offline-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.slide-down-enter-active,
.slide-down-leave-active {
  transition:
    transform var(--motion-normal) var(--ease-out),
    opacity var(--motion-normal) var(--ease-out);
}

.slide-down-enter-from,
.slide-down-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}

.chat__stream {
  display: grid;
  gap: 1.3rem;
  max-width: calc(var(--chat-measure) + 3rem);
  margin-inline: auto;
}

.chat__loading {
  max-width: calc(var(--chat-measure) + 3rem);
  margin-inline: auto;
  display: grid;
  gap: 1.4rem;
}

.chat__loading-row {
  display: grid;
  gap: 0.5rem;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--motion-normal) var(--ease-out);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

@media (max-width: 1023px) {
  .chat__messages {
    padding: 1.2rem 0.9rem;
  }
}
</style>
