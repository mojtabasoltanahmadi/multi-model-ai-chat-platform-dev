import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Message, MessageStatus } from './message.entity';
import { ConversationsService } from '../conversations/conversations.service';
import { ModelsService } from '../models/models.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { GenerationRegistry, GenerationEvent } from './generation.registry';
import { AiModel } from '../models/ai-model.entity';

const NEW_CONVERSATION_TITLE = 'گفتگوی جدید';
const TITLE_MAX_LENGTH = 60;

/**
 * Events streamed to a client during a turn — both on initial send and on
 * reconnect.
 *  - meta:     once, first (send only): the persisted user row, the
 *              pre-persisted assistant row (status 'pending'), the model, and
 *              whether this send was recognized as a replay (idempotent retry).
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
 */
export type ChatStreamEvent =
  | { type: 'meta'; userMessage: Message; assistantMessage: Message; model: AiModel; replay: boolean }
  | { type: 'snapshot'; assistantMessage: Message }
  | { type: 'delta'; text: string }
  | { type: 'done'; assistantMessage: Message }
  | { type: 'failed'; assistantMessage: Message; clientMessage: string };

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

  constructor(
    @InjectRepository(Message)
    private readonly messagesRepository: Repository<Message>,
    private readonly conversationsService: ConversationsService,
    private readonly modelsService: ModelsService,
    private readonly aiProviderService: AiProviderService,
    private readonly generationRegistry: GenerationRegistry,
    configService: ConfigService,
  ) {
    this.persistIntervalMs = configService.get<number>('ai.persistIntervalMs') ?? 1500;
  }

  /** Loads a user's conversation including its messages. */
  getConversationWithMessages(userId: string, conversationId: string) {
    return this.conversationsService.getOwnedWithMessages(userId, conversationId);
  }

  /**
   * Pre-flight for a chat turn: throws the proper HTTP error (404/400) if the
   * conversation is unknown/not owned, the model is invalid/inactive, or the
   * idempotency key collides with a different message body. Runs before the
   * SSE response starts, so errors reach the client as JSON.
   */
  async assertChatTurnAllowed(
    userId: string,
    conversationId: string,
    modelId?: string,
    idempotency?: { clientMessageId?: string; content: string },
  ): Promise<void> {
    await this.conversationsService.getOwned(userId, conversationId);
    await this.modelsService.resolveChatModel(modelId, 'free');

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
    }
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
  ): Promise<ChatTurnHandle> {
    const { conversation, messages } =
      await this.conversationsService.getOwnedWithMessages(userId, conversationId);

    const model = await this.modelsService.resolveChatModel(modelId, 'free');

    // ---- Idempotency: reuse the original user row if this is a retry. ----
    // Content-collision with the same clientMessageId was already rejected
    // by assertChatTurnAllowed; if we still find a match here, its content
    // matches and this is a genuine replay.
    let userMessage: Message;
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
      } else {
        userMessage = await this.messagesRepository.save(
          this.messagesRepository.create({
            conversationId: conversation.id,
            role: 'user',
            content,
            clientMessageId,
          }),
        );
      }
    } else {
      userMessage = await this.messagesRepository.save(
        this.messagesRepository.create({
          conversationId: conversation.id,
          role: 'user',
          content,
        }),
      );
    }

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
    // user row just resolved above.
    const history = [
      ...messages.map((message) => ({ role: message.role, content: message.content })),
      { role: 'user' as const, content: userMessage.content },
    ];

    this.generationRegistry.register(assistantMessage.id);
    const messageId = assistantMessage.id;

    let completionResolve!: (message: Message) => void;
    const completion = new Promise<Message>((resolve) => {
      completionResolve = resolve;
    });

    // Subscribe the event feed FIRST so the `events` generator can also
    // surface buffered events that happen before the caller subscribes.
    const buffer: GenerationEvent[] = [];
    let notify: (() => void) | null = null;
    const unsubscribe = this.generationRegistry.subscribe(messageId, (event) => {
      buffer.push(event);
      notify?.();
    });

    // The generation loop — deliberately not awaited by the caller. It runs
    // to a persisted terminal state whether or not anyone is subscribed.
    void this.runGeneration(assistantMessage, history, model, completionResolve).catch(
      (error) => {
        // runGeneration handles its own failures; this is a last-resort net.
        this.logger.error(
          `Generation loop escaped for message ${messageId}: ${String(error)}`,
        );
      },
    );

    async function* eventFeed(): AsyncGenerator<ChatStreamEvent> {
      // The feed is uniform: meta first (from the resolved turn), then live
      // generation events, then exactly one terminal event.
      yield {
        type: 'meta',
        userMessage,
        assistantMessage: { ...assistantMessage },
        model,
        replay,
      };
      try {
        while (true) {
          while (buffer.length > 0) {
            const event = buffer.shift()!;
            if (event.type === 'delta') yield { type: 'delta', text: event.text };
            else if (event.type === 'done') {
              yield { type: 'done', assistantMessage: event.message };
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
      userMessage,
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
   */
  private async runGeneration(
    assistantMessage: Message,
    history: { role: 'user' | 'assistant'; content: string }[],
    model: AiModel,
    completionResolve: (message: Message) => void,
  ): Promise<void> {
    const messageId = assistantMessage.id;
    let streamingFlipped = false;
    let lastPersistedAt = 0;

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
      for await (const delta of this.aiProviderService.streamChat(history, model)) {
        assistantMessage.content += delta;
        if (!streamingFlipped) {
          assistantMessage.status = 'streaming';
          streamingFlipped = true;
          await persistProgress(true);
        }
        this.generationRegistry.publishDelta(messageId, delta);
        await persistProgress(false);
      }

      assistantMessage.status = 'completed';
      const saved = await this.messagesRepository.save(assistantMessage);
      this.generationRegistry.publishDone(messageId, saved);
      completionResolve(saved);
    } catch (error) {
      // Disconnect never lands here — it only unsubscribes. This is a real
      // AI/provider/DB failure.
      const isAbort = error instanceof Error && error.name === 'AbortError';
      this.logger.error(
        `AI generation failed for message ${messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      assistantMessage.status = 'failed';
      assistantMessage.errorMessage = isAbort
        ? 'AI request timed out.'
        : error instanceof Error
          ? error.message
          : String(error);
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
        isAbort
          ? 'پاسخ هوش مصنوعی بیش از حد طول کشید. لطفاً دوباره تلاش کنید.'
          : 'سرویس هوش مصنوعی موقتاً در دسترس نیست. لطفاً دوباره تلاش کنید.',
      );
      completionResolve(saved);
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
   * Recovery stream for a reconnecting client (refresh, new tab, restored
   * connection). Ownership-validated. Yields `snapshot` first (the full
   * content so far — the client replaces, never appends), then only the
   * remaining live deltas, then a terminal event. Never re-invokes the AI:
   *
   *   - live generation   → snapshot + remaining deltas + done/failed
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
        message.status = 'interrupted';
        message.errorMessage = 'Generation is no longer running (server restart).';
        await this.messagesRepository.save(message);
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
          } else if (event.type === 'done') {
            yield { type: 'done', assistantMessage: event.message };
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
