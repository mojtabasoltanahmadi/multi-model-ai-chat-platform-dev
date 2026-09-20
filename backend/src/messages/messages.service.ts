import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Message, MessageStatus } from './message.entity';
import { ConversationsService } from '../conversations/conversations.service';
import { ModelsService, UserPlan } from '../models/models.service';
import { QuotaService } from '../usage/quota.service';
import { UsageService } from '../usage/usage.service';
import { EntitlementsService } from '../billing/entitlements.service';
import type { PlanFeatures } from '../billing/entitlements.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { ProviderError, ProviderErrorKind } from '../ai/provider-errors';
import {
  GenerationRegistry,
  GenerationEvent,
  GenerationStatus,
} from './generation.registry';
import { AiModel } from '../models/ai-model.entity';
import { FilesService, AttachedFileContext } from '../files/files.service';
import { WebSearchService } from '../websearch/websearch.service';
import type { MessageSource } from '../websearch/websearch.types';
import { buildContextualPrompt } from './file-context';

const NEW_CONVERSATION_TITLE = 'گفتگوی جدید';
const TITLE_MAX_LENGTH = 60;

/**
 * Retryable provider failures eligible for the single-hop fallback
 * (day-7-8 contract §12): the provider may recover on another model.
 * Everything else (auth, invalid-request, invalid-config, unknown) fails
 * the turn immediately — retrying a bad key or a bad request is pointless.
 */
const FALLBACK_ELIGIBLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
  'timeout',
  'rate-limit',
  'unavailable',
]);

/**
 * Sentinel for a user-stopped generation (Stop button). Never retryable,
 * never a failure: the generation loop routes it to the 'interrupted'
 * finalization instead of the 'failed' path.
 */
const cancelledError = (): ProviderError =>
  new ProviderError('cancelled', null, 'Generation was cancelled by the client.');

/** Plan-scoped access facts the generation loop needs at fallback time. */
export interface TurnAccess {
  /** null = all models allowed (plan allowlist from billing). */
  allowedModelIds: string[] | null;
  features: PlanFeatures;
}

/**
 * Events streamed to a client during a turn — both on initial send and on
 * reconnect.
 *  - meta:     once, first (send only): the persisted user row, the
 *              pre-persisted assistant row (status 'pending'), the model,
 *              whether this send was recognized as a replay (idempotent
 *              retry), and whether the web-search phase is active for this
 *              turn (server-decided — the client flag alone is never proof).
 *  - status:   execution-phase narration from the closed set
 *              ('thinking' before the first token, 'generating' at the
 *              first delta); `detail: 'fallback'` marks the single-hop
 *              provider switch. Ephemeral — never persisted or replayed on
 *              reconnect; clients keep the previous phase until the next one.
 *  - search_started:   send only, web-search turns: the live search began.
 *  - search_completed: send only, web-search turns: `resultCount` hits kept;
 *              `warning` is the safe degrade notice (null when the answer
 *              uses web context). Clients show "N sources found" or the
 *              warning and keep streaming — the turn never crashes on a
 *              search failure.
 *  - sources:  web-search turns: the turn's citations, streamed once right
 *              after they were persisted (also forwarded to reconnecting
 *              subscribers); clients REPLACE their copy. Sources also ride
 *              the terminal row, so clients without this event lose nothing.
 *  - snapshot: reconnect only, first: the full content accumulated so far.
 *              The client REPLACES its copy with this — never appends.
 *  - delta:    one new text chunk. Append only. Together with the snapshot
 *              (or an empty start) these concatenate to the exact answer —
 *              no token is ever delivered twice (Invariant 10).
 *  - done:     terminal success; final persisted assistant row.
 *  - failed:   terminal failure; persisted row (status 'failed' or, for an
 *              orphaned generation, honestly 'interrupted') + a safe
 *              user-facing message. Clients offer Retry; the internal
 *              errorMessage is never part of this payload.
 *  - cancelled: terminal; the user stopped this generation (Stop button).
 *              The persisted row (status 'interrupted', partial content)
 *              rides along so clients finalize without fabricating state.
 */
export type ChatStreamEvent =
  | {
      type: 'meta';
      userMessage: Message;
      assistantMessage: Message;
      model: AiModel;
      replay: boolean;
      webSearch: boolean;
    }
  | { type: 'status'; status: GenerationStatus; detail?: string }
  | { type: 'search_started' }
  | { type: 'search_completed'; resultCount: number; warning: string | null }
  | { type: 'sources'; sources: MessageSource[] }
  | { type: 'snapshot'; assistantMessage: Message }
  | { type: 'delta'; text: string }
  | { type: 'done'; assistantMessage: Message }
  | { type: 'failed'; assistantMessage: Message; clientMessage: string }
  | { type: 'cancelled'; assistantMessage: Message };

/** Shape of the object returned by beginChatTurn. */
export interface ChatTurnHandle {
  userMessage: Message;
  assistantMessage: Message;
  model: AiModel;
  replay: boolean;
  /**
   * Resolves with the final persisted assistant row. Never rejects — every
   * failure path persists a row with status='failed'. Generation runs
   * detached: the promise settles even when no subscriber is connected.
   */
  completion: Promise<Message>;
  /** Live feed of generation events; unsubscribing never stops the loop. */
  events: AsyncGenerator<ChatStreamEvent>;
}

/**
 * Orchestrates one chat turn. The data flow is:
 *
 *   1. validate ownership + model + idempotency
 *   2. resolve user row (reuse by clientMessageId, else create)
 *   3. pre-persist assistant row with status='pending'
 *   4. start the generation DETACHED from the HTTP response:
 *      • first delta flips status to 'streaming' (persisted immediately)
 *      • content is persisted incrementally (throttled to persistIntervalMs)
 *      • completion → 'completed'; AI failure → 'failed'
 *      • client disconnect only removes a subscriber — generation continues
 *   5. reconnecting clients re-enter via reconnectGeneration(): snapshot +
 *      remaining deltas from the live generation, or an honest 'interrupted'
 *      marking when the generation no longer exists (e.g. server restart).
 *
 * Whatever happens, exactly one user row + one assistant row are persisted
 * per turn. The database — not any client — is the source of truth.
 */
@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);
  private readonly persistIntervalMs: number;
  private readonly maxFileContextChars: number;
  /** Bound for the Stop endpoint's wait on the generation's terminal state. */
  private readonly stopSettleTimeoutMs: number;

  constructor(
    @InjectRepository(Message)
    private readonly messagesRepository: Repository<Message>,
    private readonly conversationsService: ConversationsService,
    private readonly modelsService: ModelsService,
    private readonly aiProviderService: AiProviderService,
    private readonly generationRegistry: GenerationRegistry,
    configService: ConfigService,
    private readonly filesService: FilesService,
    private readonly webSearchService: WebSearchService,
    private readonly entitlementsService: EntitlementsService,
    private readonly quotaService: QuotaService,
    private readonly usageService: UsageService,
  ) {
    this.persistIntervalMs = configService.get<number>('ai.persistIntervalMs') ?? 1500;
    this.maxFileContextChars = configService.get<number>('files.maxContextChars') ?? 24000;
    this.stopSettleTimeoutMs = configService.get<number>('ai.stopSettleTimeoutMs') ?? 5000;
  }

  /** Loads a user's conversation including its messages. */
  getConversationWithMessages(userId: string, conversationId: string) {
    return this.conversationsService.getOwnedWithMessages(userId, conversationId);
  }

  /**
   * Pre-flight for a chat turn: throws the proper HTTP error (404/400/403/429)
   * if the conversation is unknown/not owned, the model is invalid/inactive/
   * not allowed for the caller's plan, the idempotency key collides with a
   * different message body, or the caller's daily quota is exhausted. Runs
   * before the SSE response starts, so errors reach the client as JSON.
   *
   * Order matters (day-7-8 contract §8/§22.6): idempotency is detected BEFORE
   * the quota check, so a replayed retry never consumes a slot; admins bypass
   * quotas entirely (but not model-state checks).
   */
  async assertChatTurnAllowed(
    userId: string,
    conversationId: string,
    modelId?: string,
    idempotency?: { clientMessageId?: string; content: string },
    fileIds?: string[],
    isAdmin = false,
    webSearchRequested = false,
  ): Promise<{ attachments: AttachedFileContext[]; plan: UserPlan; access: TurnAccess }> {
    await this.conversationsService.getOwned(userId, conversationId);

    // Global search kill-switch (day-7-8 contract §9/§16): a turn that asks
    // for web search while the platform feature is off fails BEFORE the SSE
    // stream opens — silently answering without web context would let the
    // user believe a search happened. Capability checks below then gate the
    // model side (server-side; the frontend flag is never trusted).
    if (webSearchRequested && !this.webSearchService.isEnabled()) {
      throw new HttpException('جستجوی وب فعال نیست.', HttpStatus.SERVICE_UNAVAILABLE);
    }

    // Entitlements are resolved FRESH from the database (subscription + plan
    // rows — never the JWT, INV-05): a payment, expiry or admin change takes
    // effect on the caller's next send; an overdue period is expired here
    // (INV-06) before it can grant anything.
    const entitlements = await this.entitlementsService.resolveForUser(userId);
    const model = await this.modelsService.resolveChatModel(modelId, entitlements.tier);

    // Plan-scoped model allowlist (null = all models allowed). Kept separate
    // from resolveChatModel so the existing free/premium model rules and any
    // future per-plan catalog both apply on every send.
    if (entitlements.allowedModelIds !== null && !entitlements.allowedModelIds.includes(model.id)) {
      throw new ForbiddenException('این مدل در طرح فعلی شما مجاز نیست.');
    }
    if (!isAdmin && webSearchRequested && !entitlements.features.webSearch) {
      throw new ForbiddenException('قابلیت جستجوی وب در طرح فعلی شما فعال نیست.');
    }
    if (!isAdmin && model.capabilities.includes('reasoning') && !entitlements.features.thinking) {
      throw new ForbiddenException('قابلیت تفکر عمیق در طرح فعلی شما فعال نیست.');
    }
    if (!isAdmin && fileIds && fileIds.length > 0 && !entitlements.features.fileProcessing) {
      throw new ForbiddenException('پیوست فایل در طرح فعلی شما فعال نیست.');
    }

    // Model-capability gate (day-7-8 contract §8): web search is an opt-in
    // feature only models with the `web-search` capability may serve. The
    // frontend disables the toggle; the backend enforces it (INV-4).
    if (webSearchRequested && !model.capabilities.includes('web-search')) {
      throw new BadRequestException('این مدل از جستجوی وب پشتیبانی نمی‌کند.');
    }

    // Attached files: resolved once here (before any SSE byte is written) so
    // a not-ready/foreign file becomes a normal JSON 400 for the client
    // instead of an opaque mid-stream error. The resolved content is handed
    // to beginChatTurn, so the text is read exactly once per turn.
    const attachments =
      fileIds && fileIds.length > 0
        ? await this.filesService.getReadyContext(conversationId, fileIds)
        : [];

    let isReplay = false;
    if (idempotency?.clientMessageId) {
      const existing = await this.messagesRepository.findOne({
        where: {
          conversationId,
          role: 'user',
          clientMessageId: idempotency.clientMessageId,
        },
      });
      if (existing && existing.content !== idempotency.content) {
        // Same intent id but different text — most likely a client bug.
        // Caught here (before the SSE headers are flushed) so the client
        // gets a normal HTTP 400, not an opaque SSE error mid-stream.
        throw new BadRequestException(
          'این پیام قبلاً با متن دیگری ارسال شده است.',
        );
      }
      isReplay = Boolean(existing);
    }

    if (!isAdmin && !isReplay) {
      await this.quotaService.assertQuota(userId, entitlements.tier, entitlements.quota);
    }

    return {
      attachments,
      plan: entitlements.tier,
      access: {
        allowedModelIds: entitlements.allowedModelIds,
        features: entitlements.features,
      },
    };
  }

  /**
   * Starts a chat turn and returns a handle. The AI generation runs detached
   * from any HTTP response: subscribers come and go, the generation always
   * runs to a persisted terminal state.
   */
  async beginChatTurn(
    userId: string,
    conversationId: string,
    content: string,
    modelId: string | undefined,
    clientMessageId: string | undefined,
    attachments: AttachedFileContext[] = [],
    plan: UserPlan = 'free',
    webSearchRequested = false,
    access?: TurnAccess,
  ): Promise<ChatTurnHandle> {
    const { conversation, messages } =
      await this.conversationsService.getOwnedWithMessages(userId, conversationId);

    const model = await this.modelsService.resolveChatModel(modelId, plan);

    // Attachment ids recorded on the user row (null when the turn had none),
    // so a refreshed client can re-render the chips from persisted state.
    const attachedFileIds = attachments.length > 0 ? attachments.map((file) => file.id) : null;

    // The contextual prompt is byte-identical whether built from the caller's
    // content or the persisted user row (a replay's content was collision-
    // checked to match), so the input size is known before any row is written.
    const contextualPrompt = buildContextualPrompt(attachments, content, this.maxFileContextChars);
    const inputChars =
      messages.reduce((sum, message) => sum + message.content.length, 0) +
      contextualPrompt.length;

    // ---- Idempotency: reuse the original user row if this is a retry. ----
    // Content-collision with the same clientMessageId was already rejected
    // by assertChatTurnAllowed; if we still find a match here, its content
    // matches and this is a genuine replay. Replays NEVER open a usage row —
    // they reuse the original turn's record (INV-6/7: charged at most once).
    let userMessage: Message | null = null;
    let replay = false;
    if (clientMessageId) {
      const replayMatch = await this.messagesRepository.findOne({
        where: {
          conversationId: conversation.id,
          role: 'user',
          clientMessageId,
        },
      });
      if (replayMatch) {
        userMessage = replayMatch;
        replay = true;
      }
    }

    if (!userMessage) {
      // User row + usage row are created ATOMICALLY (one transaction): a
      // crash can never leave an accepted turn unrecorded, and the unique
      // message_id makes double-recording structurally impossible.
      userMessage = await this.messagesRepository.manager.transaction(async (manager) => {
        const saved = await manager.save(
          this.messagesRepository.create({
            conversationId: conversation.id,
            role: 'user',
            content,
            clientMessageId,
            attachedFileIds,
          }),
        );
        await this.usageService.recordTurnStart(manager, {
          userId,
          conversationId: conversation.id,
          messageId: saved.id,
          model,
          inputChars,
        });
        return saved;
      });
    }

    // Narrowed for the closures below (TS cannot see the assignment through
    // the transaction branch).
    const turnUserMessage = userMessage as Message;

    // First message names the conversation (only on a freshly created user
    // row — never on a retry, which would silently erase the user's title).
    if (!replay && messages.length === 0 && conversation.title === NEW_CONVERSATION_TITLE) {
      conversation.title = content.trim().slice(0, TITLE_MAX_LENGTH);
      await this.conversationsService.renameTitle(conversation, conversation.title);
    }

    // Pre-persist the assistant row so a reload mid-stream always finds it.
    const assistantMessage = await this.messagesRepository.save(
      this.messagesRepository.create({
        conversationId: conversation.id,
        role: 'assistant',
        content: '',
        status: 'pending' as MessageStatus,
        errorMessage: null,
        modelId: model.id,
      }),
    );

    // Provider history from everything persisted up to and including the
    // user row just resolved above. Attached READY files are injected as
    // bounded context in front of THIS turn's question; the persisted user
    // row keeps the user's own text (attachments are referenced by id).
    // With no attachments the prompt is byte-identical to the old behaviour.
    const history = [
      ...messages.map((message) => ({ role: message.role, content: message.content })),
      {
        role: 'user' as const,
        content: contextualPrompt,
      },
    ];

    const messageId = assistantMessage.id;

    let completionResolve!: (message: Message) => void;
    const completion = new Promise<Message>((resolve) => {
      completionResolve = resolve;
    });

    // Registered with its completion promise so the Stop endpoint can await
    // this generation's deterministic terminal state before responding.
    this.generationRegistry.register(messageId, completion);

    // Subscribe the event feed FIRST so the `events` generator can also
    // surface buffered events that happen before the caller subscribes.
    const buffer: GenerationEvent[] = [];
    let notify: (() => void) | null = null;
    const unsubscribe = this.generationRegistry.subscribe(messageId, (event) => {
      buffer.push(event);
      notify?.();
    });

    // Opt-in live web search (Invariant 1: without an explicit request no
    // external search API is ever touched). Backend enforcement (Invariant
    // 7): the global kill-switch gates the provider call — a client flag
    // alone is never sufficient.
    const searchActive = webSearchRequested && this.webSearchService.isEnabled();

    // The generation loop — deliberately not awaited by the caller. It runs
    // to a persisted terminal state whether or not anyone is subscribed.
    // A user-initiated Stop aborts the registry's cancellation signal; the
    // loop then stops consuming the provider stream and persists the partial
    // row as 'interrupted' (never 'completed', never 'failed').
    void this.runGeneration(
      assistantMessage,
      history,
      model,
      completionResolve,
      turnUserMessage.id,
      searchActive ? { query: turnUserMessage.content } : null,
      plan,
      access,
      this.generationRegistry.cancelSignal(messageId) ?? new AbortController().signal,
    ).catch((error) => {
      // runGeneration handles its own failures; this is a last-resort net.
      this.logger.error(
        `Generation loop escaped for message ${messageId}: ${String(error)}`,
      );
    });

    async function* eventFeed(): AsyncGenerator<ChatStreamEvent> {
      // The feed is uniform: meta first (from the resolved turn), then live
      // generation events, then exactly one terminal event.
      yield {
        type: 'meta',
        userMessage: turnUserMessage,
        assistantMessage: { ...assistantMessage },
        model,
        replay,
        webSearch: searchActive,
      };
      try {
        while (true) {
          while (buffer.length > 0) {
            const event = buffer.shift()!;
            if (event.type === 'delta') yield { type: 'delta', text: event.text };
            else if (event.type === 'status') {
              yield { type: 'status', status: event.status, detail: event.detail };
            } else if (event.type === 'search_started') yield { type: 'search_started' };
            else if (event.type === 'search_completed') {
              yield {
                type: 'search_completed',
                resultCount: event.resultCount,
                warning: event.warning,
              };
            } else if (event.type === 'sources') {
              yield { type: 'sources', sources: event.sources };
            } else if (event.type === 'done') {
              yield { type: 'done', assistantMessage: event.message };
              return;
            } else if (event.type === 'cancelled') {
              yield { type: 'cancelled', assistantMessage: event.message };
              return;
            } else {
              yield {
                type: 'failed',
                assistantMessage: event.message,
                clientMessage: event.clientMessage,
              };
              return;
            }
          }
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          notify = null;
        }
      } finally {
        unsubscribe();
      }
    }

    return {
      userMessage: turnUserMessage,
      assistantMessage,
      model,
      replay,
      completion,
      events: eventFeed(),
    };
  }

  /**
   * The detached generation loop: consumes provider deltas, publishes them
   * to subscribers, and persists progress incrementally (throttled) so a
   * crash loses at most ~persistIntervalMs of text. Client disconnection
   * never reaches this loop — it only removes subscribers.
   *
   * Cancellation (the user's Stop button) aborts `cancelSignal`; the loop
   * then stops consuming the provider stream and persists the partial row
   * as 'interrupted' — never 'completed', never 'failed'. Tokens that arrive
   * after the abort are discarded at the checkpoint below, so they never
   * mutate the persisted message.
   */
  private async runGeneration(
    assistantMessage: Message,
    history: { role: 'user' | 'assistant'; content: string }[],
    model: AiModel,
    completionResolve: (message: Message) => void,
    /** The usage row's anchor: the USER message id (unique per turn). */
    usageMessageId: string,
    /** Web-search descriptor for opted-in turns; null means a plain turn. */
    search: { query: string } | null,
    /** Caller's plan — fallback accessibility re-check (contract §12). */
    plan: UserPlan = 'free',
    /** Plan-scoped allowlist/features re-checked for the fallback model. */
    access?: TurnAccess,
    /** Aborted by the user's Stop (GenerationRegistry.requestCancel). */
    cancelSignal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const messageId = assistantMessage.id;
    let streamingFlipped = false;
    let lastPersistedAt = 0;
    // Rebindable so the web-search phase can prepend its context block to
    // THIS turn's question before the provider call.
    let prompt = history;
    // Provider-reported token usage (0–1× per stream, typically last chunk).
    let providerUsage: { inputTokens: number; outputTokens: number } | null = null;

    const persistProgress = async (force: boolean): Promise<void> => {
      const now = Date.now();
      // Buffer DB writes: one UPDATE per interval is enough to guarantee a
      // meaningful partial response survives a crash, without one round-trip
      // per token.
      if (!force && now - lastPersistedAt < this.persistIntervalMs) return;
      lastPersistedAt = now;
      await this.messagesRepository.update(messageId, {
        content: assistantMessage.content,
        status: assistantMessage.status,
      });
    };

    try {
      // Web search phase (only for opted-in turns): the client's own message
      // is the query (no extra model call in the MVP). Any failure degrades
      // to a normal turn — the search warning travels with `search_completed`
      // and the sources (if any) are persisted on this assistant row, so each
      // source belongs to exactly the turn that searched for it (Invariant 2).
      if (search) {
        this.generationRegistry.publishSearchStarted(messageId);
        const run = await this.webSearchService.runForTurn(search.query);
        const sources: MessageSource[] = run.sources;
        assistantMessage.sources = sources.length > 0 ? sources : null;
        if (assistantMessage.sources) {
          await this.messagesRepository.update(messageId, {
            sources: assistantMessage.sources,
          });
        }
        this.generationRegistry.publishSearchCompleted(
          messageId,
          sources.length,
          run.warning,
        );
        // Citations stream BEFORE the first delta (contract §11) so the UI
        // can render them while the answer is still generating; they also
        // ride the terminal row for clients that missed this event.
        if (assistantMessage.sources) {
          this.generationRegistry.publishSources(messageId, assistantMessage.sources);
        }
        if (run.contextBlock) {
          const last = prompt[prompt.length - 1];
          prompt = [
            ...prompt.slice(0, -1),
            { role: last.role, content: `${run.contextBlock}\n\n${last.content}` },
          ];
        }
      }

      // Stop during the search phase: the search itself is not abortable,
      // but the turn must not open a provider call for a stopped user.
      if (cancelSignal.aborted) {
        throw cancelledError();
      }

      // Provider loop with the single-hop fallback (day-7-8 contract §12):
      // one retry on a RETRYABLE normalized failure (timeout / rate-limit /
      // unavailable), only BEFORE the first published delta, only onto the
      // admin-configured fallback model, and never back onto an already-
      // attempted model — `attemptedModelIds` makes A→B→A loops impossible.
      let currentModel = model;
      const attemptedModelIds = new Set<string>([model.id]);
      // The first provider attempt opens with the honest `thinking` label;
      // a fallback attempt skips it (the switch already announced
      // `generating` + `fallback`).
      let firstAttempt = true;

      while (true) {
        // Honest execution-phase narration (contract §10): the provider is
        // warming up / reasoning until the first token flips the phase to
        // `generating`.
        if (firstAttempt && !streamingFlipped) {
          this.generationRegistry.publishStatus(messageId, 'thinking');
        }
        try {
          for await (const event of this.aiProviderService.streamChat(
            prompt,
            currentModel,
            cancelSignal,
          )) {
            // Cancellation checkpoint: any token surfaced after the user
            // stopped is discarded — it must never mutate the persisted
            // assistant message (Stop vs incoming token, deterministic).
            if (cancelSignal.aborted) {
              throw cancelledError();
            }
            if (event.type === 'text') {
              assistantMessage.content += event.text;
              if (!streamingFlipped) {
                assistantMessage.status = 'streaming';
                streamingFlipped = true;
                // Uniform `generating` signal coincides with the first delta
                // (contract §11) — emitted before the text so clients that
                // key their UI off status events never miss the phase.
                this.generationRegistry.publishStatus(messageId, 'generating');
                await persistProgress(true);
              }
              this.generationRegistry.publishDelta(messageId, event.text);
              await persistProgress(false);
            } else if (event.type === 'usage') {
              providerUsage = {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
              };
            } else if (event.type === 'status') {
              // Provider-signaled phase (e.g. an extended-thinking block
              // started). Forward only BEFORE the first published delta
              // (contract §11 rule 2); the label is safe status narration —
              // reasoning CONTENT never leaves the adapter (INV-12).
              if (!streamingFlipped) {
                this.generationRegistry.publishStatus(messageId, event.status);
              }
            }
          }
          break; // stream ended cleanly
        } catch (error) {
          // Cancellation is never retryable — it must not be routed into
          // the fallback (a stopped turn stays stopped, on the model that
          // was actually answering), nor classified as a provider failure.
          if (
            cancelSignal.aborted ||
            (error instanceof ProviderError && error.kind === 'cancelled')
          ) {
            throw error;
          }
          // Fallback decision — branch on the normalized kind ONLY.
          const retryable =
            error instanceof ProviderError && FALLBACK_ELIGIBLE_KINDS.has(error.kind);
          const fallbackId = currentModel.fallbackModelId;
          if (
            !retryable ||
            streamingFlipped ||
            !fallbackId ||
            attemptedModelIds.has(fallbackId)
          ) {
            throw error; // final failure → the outer catch below
          }
          const fallback = await this.modelsService.resolveFallbackCandidate(
            fallbackId,
            plan,
            access,
          );
          if (!fallback) {
            // Fallback missing/inactive/not allowed for this caller — fail
            // with the ORIGINAL provider error (never fall into a 403).
            throw error;
          }
          attemptedModelIds.add(fallback.id);
          firstAttempt = false;
          this.logger.log(
            `ProviderFallback messageId=${messageId} fromModel=${currentModel.id} ` +
              `toModel=${fallback.id} kind=${error.kind}`,
          );
          currentModel = fallback;
          // The assistant row is attributed to the model that will actually
          // answer — updated BEFORE any published delta, so the terminal
          // `done` payload, the persisted history and the usage row all
          // agree on the fallback model (contract §12/§22.6).
          assistantMessage.modelId = fallback.id;
          await this.messagesRepository.update(messageId, { modelId: fallback.id });
          await this.usageService.recordFallbackModel(usageMessageId, fallback);
          this.generationRegistry.publishStatus(messageId, 'generating', 'fallback');
        }
      }

      // Stop vs natural completion, resolved deterministically: if the abort
      // landed at any point before this write, the turn is stopped — it can
      // never become 'completed' afterwards.
      if (cancelSignal.aborted) {
        throw cancelledError();
      }

      assistantMessage.status = 'completed';
      const saved = await this.messagesRepository.save(assistantMessage);
      this.generationRegistry.publishDone(messageId, saved);
      completionResolve(saved);
      // Accounting trails the terminal publish so clients are never delayed;
      // recordTurnEnd is best-effort and never throws (INV-7).
      await this.usageService.recordTurnEnd(usageMessageId, {
        outcome: 'completed',
        inputTokens: providerUsage?.inputTokens ?? null,
        outputTokens: providerUsage?.outputTokens ?? null,
        outputChars: assistantMessage.content.length,
      });
    } catch (error) {
      // A user Stop (cancelSignal abort) or a provider stream abort that the
      // orchestrator classified as 'cancelled' is NEVER a failure: persist
      // the partial row as 'interrupted' — the same honest terminal state as
      // an orphaned generation — publish the terminal 'cancelled' event and
      // skip fallback/retry entirely. Exactly one finalization per turn.
      if (
        cancelSignal.aborted ||
        (error instanceof ProviderError && error.kind === 'cancelled')
      ) {
        this.logger.log(`Generation cancelled for message ${messageId}`);
        assistantMessage.status = 'interrupted';
        assistantMessage.errorMessage = null;
        let savedStopped = assistantMessage;
        try {
          savedStopped = await this.messagesRepository.save(assistantMessage);
        } catch (persistError) {
          // DB failed while recording the stop — log and continue so
          // attached clients still get the terminal event.
          this.logger.error(`Failed to persist cancelled state: ${String(persistError)}`);
        }
        this.generationRegistry.publishCancelled(messageId, savedStopped);
        completionResolve(savedStopped);
        // A stopped turn really consumed tokens (if any arrived) — recorded
        // like any interrupted turn, best-effort and exactly once (INV-7).
        await this.usageService.recordTurnEnd(usageMessageId, {
          outcome: 'interrupted',
          inputTokens: providerUsage?.inputTokens ?? null,
          outputTokens: providerUsage?.outputTokens ?? null,
          outputChars: assistantMessage.content.length,
        });
        return;
      }
      // Disconnect never lands here — it only unsubscribes. This is a real
      // AI/provider/DB failure, normalized to a ProviderError kind by the
      // adapter layer; branch on the kind only (never message text).
      const isTimeout =
        (error instanceof ProviderError && error.kind === 'timeout') ||
        (error instanceof Error && error.name === 'AbortError');
      this.logger.error(
        `AI generation failed for message ${messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      assistantMessage.status = 'failed';
      assistantMessage.errorMessage =
        error instanceof Error ? error.message : String(error);
      let saved = assistantMessage;
      try {
        saved = await this.messagesRepository.save(assistantMessage);
      } catch (persistError) {
        // DB itself failed while recording the failure — log and continue so
        // connected clients at least get the terminal event.
        this.logger.error(`Failed to persist failure state: ${String(persistError)}`);
      }
      this.generationRegistry.publishFailed(
        messageId,
        saved,
        isTimeout
          ? 'پاسخ هوش مصنوعی بیش از حد طول کشید. لطفاً دوباره تلاش کنید.'
          : 'سرویس هوش مصنوعی موقتاً در دسترس نیست. لطفاً دوباره تلاش کنید.',
      );
      completionResolve(saved);
      // Failed turns are still RECORDED (tokens already spent are real) but
      // are excluded from the quota count — the outcome is the discriminator.
      await this.usageService.recordTurnEnd(usageMessageId, {
        outcome: 'failed',
        inputTokens: providerUsage?.inputTokens ?? null,
        outputTokens: providerUsage?.outputTokens ?? null,
        outputChars: assistantMessage.content.length,
      });
    } finally {
      this.generationRegistry.unregister(messageId);
    }
  }

  /**
   * Pre-flight for the reconnect stream: throws 404 (unknown/foreign
   * conversation or message) BEFORE the SSE headers are flushed, so the
   * client gets a normal JSON error instead of an opaque closed stream.
   */
  async assertReconnectAllowed(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    const { messages } = await this.conversationsService.getOwnedWithMessages(
      userId,
      conversationId,
    );
    if (!messages.some((m) => m.id === messageId && m.role === 'assistant')) {
      throw new NotFoundException('پیام پیدا نشد.');
    }
  }

  /**
   * User-initiated Stop (chat composer button) for the conversation's active
   * generation. Ownership-validated: a caller can only ever stop a turn in
   * their own conversation — never another user's generation.
   *
   *  - live generation   → its cancellation signal is aborted; the loop stops
   *    consuming the provider stream and persists the partial row as
   *    'interrupted' (never 'completed', never 'failed'). The endpoint then
   *    awaits the loop's completion (bounded) so the response carries the
   *    authoritative final row — if natural completion won the race, that
   *    row is 'completed' and the client renders the full answer.
   *  - orphaned pending/streaming row (server restarted mid-generation) →
   *    honestly marked 'interrupted' so a deliberate stop stays stopped.
   *  - nothing open      → `{ stopped: false }`; repeated Stop calls are
   *    idempotent (aborting the same signal twice is a no-op) and never
   *    touch completed/failed/interrupted rows.
   *
   * In-process scope matches the registry (and the reconnect design): a
   * generation owned by another process instance is not reachable here.
   */
  async stopConversationGeneration(
    userId: string,
    conversationId: string,
  ): Promise<{ stopped: boolean; message: Message | null }> {
    await this.conversationsService.getOwned(userId, conversationId);

    const openRows = await this.messagesRepository.find({
      where: {
        conversationId,
        role: 'assistant',
        status: In(['pending', 'streaming'] as MessageStatus[]),
      },
      order: { createdAt: 'DESC' },
    });

    let stopped = false;
    let stoppedMessage: Message | null = null;
    for (const row of openRows) {
      const completion = this.generationRegistry.completion(row.id);
      if (completion) {
        this.generationRegistry.requestCancel(row.id);
        // Deterministic settle: wait (bounded) for the loop to persist the
        // terminal row — the stop must not report before the database
        // agrees. On a pathological hang the bound elapses and the response
        // simply omits the row; the DB still converges asynchronously.
        const settled = await Promise.race([
          completion,
          new Promise<null>((resolve) => {
            setTimeout(() => resolve(null), this.stopSettleTimeoutMs);
          }),
        ]);
        if (!stoppedMessage) stoppedMessage = settled;
      } else {
        await this.markOrphanedInterrupted(row);
        if (!stoppedMessage) stoppedMessage = row;
      }
      stopped = true;
    }
    return { stopped, message: stoppedMessage };
  }

  /**
   * Honestly marks an orphaned pending/streaming row 'interrupted' so it is
   * retryable and never looks "completed" while it is not. The usage row
   * (created at acceptance) is reconciled to outcome='interrupted' — its
   * partial output counts, since those tokens were really consumed. Shared
   * by the reconnect stream and the Stop endpoint.
   */
  private async markOrphanedInterrupted(message: Message): Promise<void> {
    message.status = 'interrupted';
    message.errorMessage = 'Generation is no longer running (server restart).';
    await this.messagesRepository.save(message);
    await this.usageService.recordTurnEnd(message.id, {
      outcome: 'interrupted',
      inputTokens: null,
      outputTokens: null,
      outputChars: message.content.length,
    });
  }

  /**
   * Recovery stream for a reconnecting client (refresh, new tab, restored
   * connection). Ownership-validated. Yields `snapshot` first (the full
   * content so far — the client replaces, never appends), then only the
   * remaining live deltas, then a terminal event. Never re-invokes the AI:
   *
   *   - live generation   → snapshot + remaining deltas + done/failed/cancelled
   *   - completed row     → snapshot + done (nothing regenerated)
   *   - failed row        → snapshot + failed terminal (Retry offered)
   *   - interrupted row   → snapshot + interrupted terminal (Retry offered)
   *   - pending/streaming row with NO live generation (server restarted
   *     mid-generation) → honestly marked 'interrupted' + terminal; the
   *     client can retry with correct context.
   *
   * Limitation (deliberate, documented): stateless completion APIs cannot
   * resume an AI stream from an exact byte/token offset, so token-exact
   * resume only works while THIS server process holds the generation live;
   * otherwise the row is marked interrupted and the user can retry.
   */
  async *reconnectGeneration(
    userId: string,
    conversationId: string,
    messageId: string,
  ): AsyncGenerator<ChatStreamEvent> {
    const { messages } = await this.conversationsService.getOwnedWithMessages(
      userId,
      conversationId,
    );
    const message = messages.find((m) => m.id === messageId && m.role === 'assistant');
    if (!message) {
      throw new NotFoundException('پیام پیدا نشد.');
    }

    if (!this.generationRegistry.isLive(messageId)) {
      if (message.status === 'pending' || message.status === 'streaming') {
        // Orphaned generation: mark it honestly so the row is retryable and
        // never looks "completed" while it is not.
        await this.markOrphanedInterrupted(message);
      }
      yield { type: 'snapshot', assistantMessage: { ...message } };
      if (message.status === 'completed') {
        yield { type: 'done', assistantMessage: { ...message } };
      } else {
        yield {
          type: 'failed',
          assistantMessage: { ...message },
          clientMessage:
            message.status === 'failed'
              ? 'سرویس هوش مصنوعی موقتاً در دسترس نیست. لطفاً دوباره تلاش کنید.'
              : 'تولید این پاسخ ناتمام ماند. می‌توانید دوباره تلاش کنید.',
        };
      }
      return;
    }

    // Live generation. Subscribe FIRST, then snapshot: every token published
    // after the subscription lands in the queue (never lost), and everything
    // before it is in the snapshot (never duplicated).
    const queue: GenerationEvent[] = [];
    let notify: (() => void) | null = null;
    const unsubscribe = this.generationRegistry.subscribe(messageId, (event) => {
      queue.push(event);
      notify?.();
    });
    try {
      const snapshotContent = this.generationRegistry.getContent(messageId) ?? message.content;
      yield { type: 'snapshot', assistantMessage: { ...message, content: snapshotContent } };
      while (true) {
        while (queue.length > 0) {
          const event = queue.shift()!;
          if (event.type === 'delta') {
            yield { type: 'delta', text: event.text };
          } else if (event.type === 'status') {
            // Live phase narration for a subscriber that attached before the
            // first delta; statuses are never REPLAYED for earlier phases.
            yield { type: 'status', status: event.status, detail: event.detail };
          } else if (event.type === 'sources') {
            // Data event: a reconnecting subscriber that attached mid-search
            // still receives this turn's citations (idempotent replace).
            yield { type: 'sources', sources: event.sources };
          } else if (event.type === 'search_started' || event.type === 'search_completed') {
            // Transient pre-AI phase: the snapshot already covers the row
            // state, so reconnecting clients safely skip these.
            continue;
          } else if (event.type === 'done') {
            yield { type: 'done', assistantMessage: event.message };
            return;
          } else if (event.type === 'cancelled') {
            // The user stopped this generation in another tab/window: the
            // row carries its persisted 'interrupted' state — finalize
            // without offering the network-recovery path.
            yield { type: 'cancelled', assistantMessage: event.message };
            return;
          } else {
            yield {
              type: 'failed',
              assistantMessage: event.message,
              clientMessage: event.clientMessage,
            };
            return;
          }
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
    } finally {
      // Runs when the terminal event was yielded OR when the consumer breaks
      // (client disconnect / response teardown). The generation itself is
      // untouched — it keeps running and persisting.
      unsubscribe();
    }
  }
}
