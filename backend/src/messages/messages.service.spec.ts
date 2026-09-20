import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { GenerationRegistry } from './generation.registry';
import { MessagesService, ChatStreamEvent, ChatTurnHandle } from './messages.service';
import { AttachedFileContext } from '../files/files.service';
import { ProviderEvent } from '../ai/provider-adapter';
import { ProviderError } from '../ai/provider-errors';
import { QuotaService } from '../usage/quota.service';
import { UsageService } from '../usage/usage.service';
import { createMockRepository } from '../test/mocks';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Provider adapters now yield normalized events — helper keeps the specs readable. */
const text = (value: string): ProviderEvent => ({ type: 'text', text: value });

/** Entitlement snapshot builder — mirrors the EntitlementsService shape. */
const entitlement = (overrides: Record<string, unknown> = {}) => ({
  tier: 'free' as const,
  planSlug: 'free',
  planName: 'رایگان',
  subscriptionId: null,
  currentPeriodEnd: null,
  quota: { dailyMessages: 50, dailyTokens: null },
  features: { webSearch: true, thinking: true, fileProcessing: true },
  allowedModelIds: null,
  ...overrides,
});

describe('MessagesService — chat turn lifecycle', () => {
  let service: MessagesService;
  let registry: GenerationRegistry;
  let messagesRepository: ReturnType<typeof createMockRepository>;
  let conversationsService: {
    getOwned: jest.Mock;
    getOwnedWithMessages: jest.Mock;
    renameTitle: jest.Mock;
  };
  let modelsService: { resolveChatModel: jest.Mock; resolveFallbackCandidate: jest.Mock };
  let aiProviderService: { streamChat: jest.Mock };
  let filesService: { getReadyContext: jest.Mock };
  let webSearchService: { isEnabled: jest.Mock; runForTurn: jest.Mock };
  let entitlementsService: { resolveForUser: jest.Mock };
  let quotaService: { assertQuota: jest.Mock };
  let usageService: {
    recordTurnStart: jest.Mock;
    recordTurnEnd: jest.Mock;
    recordFallbackModel: jest.Mock;
  };

  const setup = ({
    history = [],
    title = 'گفتگوی جدید',
    persistIntervalMs = 60_000,
    existingUserByClientMid = null,
    readyFiles = [] as AttachedFileContext[],
  }: {
    history?: { role: 'user' | 'assistant'; content: string }[];
    title?: string;
    persistIntervalMs?: number;
    existingUserByClientMid?: { id: string; content: string } | null;
    readyFiles?: AttachedFileContext[];
  } = {}) => {
    conversationsService = {
      getOwned: jest.fn().mockResolvedValue({ id: 'conv-1', userId: 'user-1', title }),
      getOwnedWithMessages: jest.fn().mockResolvedValue({
        conversation: { id: 'conv-1', userId: 'user-1', title },
        messages: history,
      }),
      renameTitle: jest.fn().mockResolvedValue(undefined),
    };
    modelsService = {
      resolveChatModel: jest.fn().mockResolvedValue({ id: 'model-1', name: 'Mock', provider: 'mock', capabilities: [] }),
      // Only consulted when a model actually declares a fallback AND the
      // provider failed with a retryable kind before the first delta.
      resolveFallbackCandidate: jest.fn().mockResolvedValue(null),
    };
    messagesRepository = createMockRepository();

    if (existingUserByClientMid) {
      messagesRepository.findOne.mockImplementation(async (options: any) => {
        if (
          options?.where?.role === 'user' &&
          options?.where?.clientMessageId === existingUserByClientMid.id
        ) {
          return {
            id: 'user-existing',
            conversationId: 'conv-1',
            role: 'user',
            content: existingUserByClientMid.content,
            clientMessageId: existingUserByClientMid.id,
          };
        }
        return null;
      });
    }

    const configService = {
      get: (key: string) =>
        key === 'ai.persistIntervalMs' ? persistIntervalMs : undefined,
    };

    // READY-file attachments are resolved before beginChatTurn (pre-flight),
    // so no SSE byte is written for a rejected attachment.
    filesService = { getReadyContext: jest.fn().mockResolvedValue(readyFiles) };

    // Web search is opt-in and disabled by default in every existing test —
    // plain turns must never touch it (Invariant 1 regression net).
    webSearchService = {
      isEnabled: jest.fn().mockReturnValue(false),
      runForTurn: jest.fn(),
    };

    // Entitlement/quota/usage collaborators default to the permissive path.
    entitlementsService = { resolveForUser: jest.fn().mockResolvedValue(entitlement()) };
    quotaService = { assertQuota: jest.fn().mockResolvedValue(undefined) };
    usageService = {
      recordTurnStart: jest.fn().mockResolvedValue(undefined),
      recordTurnEnd: jest.fn().mockResolvedValue(undefined),
      recordFallbackModel: jest.fn().mockResolvedValue(undefined),
    };

    registry = new GenerationRegistry();
    service = new MessagesService(
      messagesRepository as any,
      conversationsService as any,
      modelsService as any,
      aiProviderService as any,
      registry,
      configService as any,
      filesService as any,
      webSearchService as any,
      entitlementsService as any,
      quotaService as any,
      usageService as any,
    );
  };

  /** Starts a turn and consumes its event feed in the background. */
  async function begin(
    ...args: Parameters<MessagesService['beginChatTurn']>
  ): Promise<{ handle: ChatTurnHandle; events: ChatStreamEvent[]; done: Promise<ChatStreamEvent[]> }> {
    const handle = await service.beginChatTurn(...args);
    const events: ChatStreamEvent[] = [];
    const done = (async () => {
      for await (const event of handle.events) {
        events.push(event);
      }
      return events;
    })();
    return { handle, events, done };
  }

  beforeEach(() => {
    aiProviderService = { streamChat: jest.fn() };
  });

  it('pre-persists an assistant row with status=pending BEFORE any chunk', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('سلام ');
      yield text('دنیا');
    });

    const { handle, done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const meta = (await done)[0] as Extract<ChatStreamEvent, { type: 'meta' }>;

    // The mock's saved[] holds a snapshot per save() call, in order.
    const assistantRows = messagesRepository.saved.filter((row: any) => row.role === 'assistant');
    // One-row-per-turn invariant is about UNIQUE rows: a successful turn
    // saves the assistant row twice (pending, then completed).
    expect(new Set(assistantRows.map((row: any) => row.id)).size).toBe(1);
    expect(assistantRows[0]).toMatchObject({
      conversationId: 'conv-1',
      role: 'assistant',
      content: '',
      status: 'pending',
      modelId: 'model-1',
    });
    expect(meta.userMessage).toMatchObject({ role: 'user', content: 'سلام' });
    expect(meta.assistantMessage).toMatchObject({ status: 'pending' });
    expect(meta.model).toMatchObject({ id: 'model-1' });
    expect(meta.replay).toBe(false);
    expect(handle.assistantMessage.id).toBe(assistantRows[0].id);
  });

  it('persists exactly ONE distinct assistant row with completed status on success', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('سلام ');
      yield text('دنیا');
    });

    const { done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events = await done;

    const assistantRows = messagesRepository.saved.filter((row: any) => row.role === 'assistant');
    expect(new Set(assistantRows.map((row: any) => row.id)).size).toBe(1);
    const finalRow = assistantRows.at(-1);
    expect(finalRow).toMatchObject({ content: 'سلام دنیا', status: 'completed' });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      assistantMessage: { content: 'سلام دنیا', status: 'completed' },
    });
  });

  it('persists ONE failed row and a generic client message on AI failure', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('پاسخ ناتمام');
      throw new Error('ECONNREFUSED 10.0.0.9:443 (internal detail)');
    });

    const { done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events = await done;

    const failed = messagesRepository.saved
      .filter((row: any) => row.role === 'assistant')
      .at(-1);
    expect(failed).toMatchObject({ status: 'failed', content: 'پاسخ ناتمام' });
    expect(failed.errorMessage).toContain('ECONNREFUSED');
    const terminal = events.at(-1) as Extract<ChatStreamEvent, { type: 'failed' }>;
    expect(terminal.type).toBe('failed');
    expect(terminal.clientMessage).not.toContain('ECONNREFUSED');
    expect(terminal.clientMessage).toContain('موقتاً در دسترس نیست');
  });

  it('keeps generating and COMPLETES after the client disconnects mid-stream', async () => {
    setup();
    const chunks = ['سلام! ', 'امروز ', 'درباره ', 'معماری ', 'نرم‌افزار'];
    aiProviderService.streamChat.mockImplementation(async function* () {
      for (const chunk of chunks) {
        await sleep(10);
        yield text(chunk);
      }
    });

    const { handle } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    // Simulate a client that leaves after the first delta (refresh mid-stream).
    const received: ChatStreamEvent[] = [];
    for await (const event of handle.events) {
      received.push(event);
      if (event.type === 'delta') break;
    }

    // The client is gone — the generation must still run to completion and
    // persist the full answer. No 'interrupted', nothing lost.
    const finalRow = await handle.completion;
    expect(finalRow.status).toBe('completed');
    expect(finalRow.content).toBe(chunks.join(''));
    expect(finalRow.content).toContain('معماری');
  });

  it('completes even when the client leaves BEFORE the first delta', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      await sleep(20);
      yield text('تنها بخش پاسخ');
    });

    const { handle } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    // Consume only the meta, then "refresh" (break) before any delta.
    for await (const event of handle.events) {
      if (event.type === 'meta') break;
    }

    const finalRow = await handle.completion;
    expect(finalRow.status).toBe('completed');
    expect(finalRow.content).toBe('تنها بخش پاسخ');
  });

  it('marks the row failed (not interrupted) on a normalized provider timeout even with no subscribers', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('قدیم ');
      throw new ProviderError('timeout', null, 'AI request for model Mock timed out.');
    });

    const { handle } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const finalRow = await handle.completion;
    expect(finalRow.status).toBe('failed');
    expect(finalRow.errorMessage).toContain('timed out');
  });

  it('still maps a bare AbortError to the timeout client message (defense in depth)', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      throw abort;
    });

    const { handle, done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events = await done;
    const finalRow = await handle.completion;
    expect(finalRow.status).toBe('failed');
    const terminal = events.at(-1) as Extract<ChatStreamEvent, { type: 'failed' }>;
    expect(terminal.clientMessage).toContain('بیش از حد طول کشید');
  });

  it('persists incremental progress while streaming (throttled, not per token)', async () => {
    setup({ persistIntervalMs: 5 });
    const chunks = ['یک ', 'دو ', 'سه ', 'چهار ', 'پنج'];
    aiProviderService.streamChat.mockImplementation(async function* () {
      for (const chunk of chunks) {
        await sleep(20); // long enough that the 5ms interval elapses repeatedly
        yield text(chunk);
      }
    });

    const { handle, done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events = await done;

    const progressUpdates = messagesRepository.update.mock.calls
      .map((call: any[]) => call[1] as { content: string; status: string })
      .filter((patch) => patch.status === 'streaming');
    // First delta forces a persist (streaming flip); the throttle then lets
    // later progress through. Several INCREMENTAL updates prove content
    // reaches the DB *during* the stream, not only at the final save.
    expect(progressUpdates.length).toBeGreaterThanOrEqual(2);
    expect(progressUpdates[0].content).toBe(chunks[0]);
    const finalContent = chunks.join('');
    for (const patch of progressUpdates) {
      // every intermediate write is a prefix of the final answer — never
      // duplicated or corrupted content
      expect(finalContent.startsWith(patch.content)).toBe(true);
    }

    const finalRow = messagesRepository.saved
      .filter((row: any) => row.role === 'assistant')
      .at(-1);
    expect(finalRow).toMatchObject({ status: 'completed', content: chunks.join('') });
    expect(events.at(-1)?.type).toBe('done');
  });

  it('completes with empty content on a zero-token response', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      /* yields nothing */
    });

    const { handle, done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events = await done;
    const finalRow = await handle.completion;
    expect(finalRow.status).toBe('completed');
    expect(finalRow.content).toBe('');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('flips the assistant row to streaming (persisted) on the first delta', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('اول');
      yield text('دوم');
    });

    await begin('user-1', 'conv-1', 'سلام', undefined, undefined);

    const firstPersist = messagesRepository.update.mock.calls[0]?.[1] as any;
    expect(firstPersist).toMatchObject({ status: 'streaming', content: 'اول' });
  });

  it('names the conversation after its first message', async () => {
    setup({ title: 'گفتگوی جدید' });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('ok');
    });

    await begin('user-1', 'conv-1', 'یک پیام نسبتاً طولانی به عنوان اولین پیام', undefined, undefined);

    expect(conversationsService.renameTitle).toHaveBeenCalledWith(
      expect.anything(),
      'یک پیام نسبتاً طولانی به عنوان اولین پیام',
    );
  });

  it('does not rename a conversation that already has a custom title', async () => {
    setup({ title: 'عنوان دلخواه' });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('ok');
    });

    await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    expect(conversationsService.renameTitle).not.toHaveBeenCalled();
  });

  it('does not rename the conversation on a retry (replay)', async () => {
    setup({
      title: 'گفتگوی جدید',
      existingUserByClientMid: { id: 'cmid-1', content: 'سلام' },
    });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('ok');
    });

    const { done } = await begin('user-1', 'conv-1', 'سلام', undefined, 'cmid-1');
    const events = await done;

    expect(conversationsService.renameTitle).not.toHaveBeenCalled();
    expect((events[0] as Extract<ChatStreamEvent, { type: 'meta' }>).replay).toBe(true);
  });

  it('attributes each assistant message to the model that produced it when switching models mid-conversation', async () => {
    setup({
      history: [{ role: 'user', content: 'اول' }, { role: 'assistant', content: 'پاسخ اول' }],
    });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('پاسخ دوم');
    });
    modelsService.resolveChatModel.mockResolvedValue({
      id: 'model-2',
      name: 'Mock 2',
      provider: 'mock',
    });

    const { done } = await begin('user-1', 'conv-1', 'دوم', 'model-2', undefined);
    await done;

    const assistantRows = messagesRepository.saved.filter((row: any) => row.role === 'assistant');
    expect(assistantRows.at(-1)).toMatchObject({ modelId: 'model-2', content: 'پاسخ دوم' });
  });

  it('includes the persisted history plus the new user message in the provider request', async () => {
    setup({
      history: [
        { role: 'user', content: 'قبلی' },
        { role: 'assistant', content: 'پاسخ قبلی' },
      ],
    });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('ok');
    });

    await begin('user-1', 'conv-1', 'جدید', undefined, undefined);

    const passedHistory = aiProviderService.streamChat.mock.calls[0][0];
    expect(passedHistory).toEqual([
      { role: 'user', content: 'قبلی' },
      { role: 'assistant', content: 'پاسخ قبلی' },
      { role: 'user', content: 'جدید' },
    ]);
  });

  it('reuses an existing user row when clientMessageId matches (no duplicate)', async () => {
    setup({ existingUserByClientMid: { id: 'cmid-1', content: 'سلام' } });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('ok');
    });

    const { handle, done } = await begin('user-1', 'conv-1', 'سلام', undefined, 'cmid-1');
    await done;

    expect(handle.userMessage.id).toBe('user-existing');
    const userRows = messagesRepository.saved.filter((row: any) => row.role === 'user');
    expect(userRows).toHaveLength(0); // nothing new persisted
  });

  it('rejects a retry whose content does not match the original user row (pre-flight)', async () => {
    setup({ existingUserByClientMid: { id: 'cmid-1', content: 'سلام' } });

    await expect(
      service.assertChatTurnAllowed('user-1', 'conv-1', undefined, {
        clientMessageId: 'cmid-1',
        content: 'متن متفاوت',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('creates a fresh user row when clientMessageId does not match anything', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('ok');
    });

    const { handle, done } = await begin('user-1', 'conv-1', 'سلام', undefined, 'brand-new');
    await done;

    expect(handle.userMessage).toMatchObject({ content: 'سلام', clientMessageId: 'brand-new' });
    expect(handle.replay).toBe(false);
  });

  // ---- attached files (Day 5-6 chat integration) ----

  it('resolves attached files per CONVERSATION during pre-flight', async () => {
    setup();

    await service.assertChatTurnAllowed(
      'user-1',
      'conv-1',
      undefined,
      { clientMessageId: undefined, content: 'سؤال' },
      ['file-1'],
    );

    // Conversation scoping is what enforces chat isolation between conversations.
    expect(filesService.getReadyContext).toHaveBeenCalledWith('conv-1', ['file-1']);
  });

  it('never queries files when the turn has no attachments', async () => {
    setup();

    await service.assertChatTurnAllowed('user-1', 'conv-1', undefined, {
      clientMessageId: undefined,
      content: 'سؤال',
    });

    expect(filesService.getReadyContext).not.toHaveBeenCalled();
  });

  it('rejects the send (400, pre-stream) when an attached file is not READY', async () => {
    setup();
    filesService.getReadyContext.mockRejectedValue(
      new BadRequestException('این فایل هنوز در حال پردازش است.'),
    );

    await expect(
      service.assertChatTurnAllowed(
        'user-1',
        'conv-1',
        undefined,
        { clientMessageId: undefined, content: 'سؤال' },
        ['file-1'],
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('injects READY file content into the prompt but keeps the stored message text', async () => {
    setup({
      readyFiles: [
        {
          id: 'file-1',
          originalName: 'report.pdf',
          mimeType: 'application/pdf',
          extractedText: 'FACT: the answer is 42',
        },
      ],
    });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('ok');
    });

    const { attachments } = await service.assertChatTurnAllowed(
      'user-1',
      'conv-1',
      undefined,
      { clientMessageId: undefined, content: 'این فایل درباره چیست؟' },
      ['file-1'],
    );
    const { handle, done } = await begin(
      'user-1',
      'conv-1',
      'این فایل درباره چیست؟',
      undefined,
      undefined,
      attachments,
    );
    await done;

    // The provider sees the attached content plus the question…
    const prompt = aiProviderService.streamChat.mock.calls[0][0].at(-1).content;
    expect(prompt).toContain('FACT: the answer is 42');
    expect(prompt).toContain('این فایل درباره چیست؟');
    // …while the conversation history stores only what the user typed, with
    // the attachment referenced by id.
    expect(handle.userMessage.content).toBe('این فایل درباره چیست؟');
    expect(handle.userMessage.attachedFileIds).toEqual(['file-1']);
  });

  it('records null attachments and an unchanged prompt for a plain turn', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('ok');
    });

    const { handle, done } = await begin('user-1', 'conv-1', 'پیام ساده', undefined, undefined);
    await done;

    expect(handle.userMessage.attachedFileIds).toBeNull();
    expect(aiProviderService.streamChat.mock.calls[0][0].at(-1).content).toBe('پیام ساده');
  });

  it('keeps the original attachments on a replay (retry) of the same turn', async () => {
    setup({
      existingUserByClientMid: { id: 'cmid-1', content: 'سلام' },
      readyFiles: [
        {
          id: 'file-1',
          originalName: 'report.pdf',
          mimeType: 'application/pdf',
          extractedText: 'body',
        },
      ],
    });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('ok');
    });

    const { attachments } = await service.assertChatTurnAllowed(
      'user-1',
      'conv-1',
      undefined,
      { clientMessageId: 'cmid-1', content: 'سلام' },
      ['file-1'],
    );
    const { handle, done } = await begin('user-1', 'conv-1', 'سلام', undefined, 'cmid-1', attachments);
    await done;

    expect(handle.replay).toBe(true);
    expect(handle.userMessage.id).toBe('user-existing');
    // Retrying must not create a second user row.
    expect(messagesRepository.saved.filter((row: any) => row.role === 'user')).toHaveLength(0);
  });

  // ---- web search (opt-in live search with sources/citations) ----

  it('never touches web search on a plain turn (Invariant 1)', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('پاسخ عادی');
    });

    const { done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events = await done;

    expect(webSearchService.runForTurn).not.toHaveBeenCalled();
    expect(
      events.some((e: ChatStreamEvent) => e.type === 'search_started' || e.type === 'search_completed'),
    ).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('runs search on an opted-in turn: lifecycle events, context injection, persisted sources', async () => {
    setup();
    webSearchService.isEnabled.mockReturnValue(true);
    webSearchService.runForTurn.mockResolvedValue({
      sources: [{ title: 'React Blog', url: 'https://react.dev/blog', domain: 'react.dev', snippet: 'S' }],
      contextBlock: '[نتایج]\nhttps://react.dev/blog',
      warning: null,
    });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('پاسخ با منبع');
    });

    const { done } = await begin('user-1', 'conv-1', 'React 19؟', undefined, undefined, [], 'free', true);
    const events = await done;

    // Lifecycle: meta → search_started → search_completed → … → done.
    expect(events[0].type).toBe('meta');
    expect(events[1]).toEqual({ type: 'search_started' });
    expect(events[2]).toEqual({ type: 'search_completed', resultCount: 1, warning: null });
    expect(events.at(-1)?.type).toBe('done');

    // The model prompt carries the search block (sources actually used).
    const history = aiProviderService.streamChat.mock.calls[0][0] as { content: string }[];
    expect(history.at(-1)?.content).toContain('https://react.dev/blog');

    // Sources are persisted on the SAME assistant row (Invariant 2/10).
    const finalRow = messagesRepository.saved
      .filter((row: any) => row.role === 'assistant')
      .at(-1);
    expect(finalRow).toMatchObject({
      status: 'completed',
      sources: [
        { title: 'React Blog', url: 'https://react.dev/blog', domain: 'react.dev', snippet: 'S' },
      ],
    });
    const doneEvent = events.at(-1) as Extract<ChatStreamEvent, { type: 'done' }>;
    expect(doneEvent.assistantMessage.sources).toHaveLength(1);
  });

  it('degrades a failed search to a normal turn with a safe warning (Invariant 6)', async () => {
    setup();
    webSearchService.isEnabled.mockReturnValue(true);
    webSearchService.runForTurn.mockResolvedValue({
      sources: [],
      contextBlock: '',
      warning: 'جستجوی وب بیش از حد طول کشید. پاسخ بدون اطلاعات وب تولید شد.',
    });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('پاسخ بدون وب');
    });

    const { done } = await begin('user-1', 'conv-1', 'React 19؟', undefined, undefined, [], 'free', true);
    const events = await done;

    const completed = events.find(
      (e: ChatStreamEvent) => e.type === 'search_completed',
    ) as Extract<ChatStreamEvent, { type: 'search_completed' }>;
    expect(completed.resultCount).toBe(0);
    expect(completed.warning).toContain('بدون اطلاعات وب');
    // The turn itself still completes — no crash, no leak of internals.
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    const history = aiProviderService.streamChat.mock.calls[0][0] as { content: string }[];
    expect(history.at(-1)?.content).toBe('React 19؟');
  });

  it('ignores the client flag when search is disabled server-side (Invariant 7)', async () => {
    setup(); // isEnabled() === false
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('پاسخ عادی');
    });

    const { done } = await begin('user-1', 'conv-1', 'React 19؟', undefined, undefined, [], 'free', true);
    const events = await done;

    expect(webSearchService.runForTurn).not.toHaveBeenCalled();
    expect(
      events.some((e: ChatStreamEvent) => e.type === 'search_started' || e.type === 'search_completed'),
    ).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  // ---- usage & quota wiring (day-7-8 contract §7) ----

  it('checks the caller quota pre-flight and resolves the model against the fresh entitlements', async () => {
    setup();
    const premium = entitlement({ tier: 'premium' });
    entitlementsService.resolveForUser.mockResolvedValue(premium);

    await service.assertChatTurnAllowed('user-1', 'conv-1', undefined, {
      clientMessageId: undefined,
      content: 'سلام',
    });

    expect(entitlementsService.resolveForUser).toHaveBeenCalledWith('user-1');
    expect(quotaService.assertQuota).toHaveBeenCalledWith('user-1', 'premium', premium.quota);
    expect(modelsService.resolveChatModel).toHaveBeenCalledWith(undefined, 'premium');
  });

  it('beginChatTurn resolves the model against the plan handed down from pre-flight', async () => {
    setup();
    entitlementsService.resolveForUser.mockResolvedValue(entitlement({ tier: 'premium' }));
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('ok');
    });

    await begin('user-1', 'conv-1', 'سلام', undefined, undefined, [], 'premium');

    // the second resolve (turn creation) uses the SAME plan, not a hard-code
    expect(modelsService.resolveChatModel).toHaveBeenLastCalledWith(undefined, 'premium');
  });

  // ---- INV-05: plan features enforced server-side (frontend is never trusted) ----

  it('rejects a web-search turn when the plan lacks the entitlement (403, pre-stream)', async () => {
    setup();
    entitlementsService.resolveForUser.mockResolvedValue(
      entitlement({ features: { webSearch: false, thinking: true, fileProcessing: true } }),
    );

    await expect(
      service.assertChatTurnAllowed('user-1', 'conv-1', undefined, { content: 'سلام' }, [], false, true),
    ).rejects.toThrow(/جستجوی وب/);
  });

  it('rejects a reasoning model when the plan lacks the thinking entitlement', async () => {
    setup();
    entitlementsService.resolveForUser.mockResolvedValue(
      entitlement({ features: { webSearch: true, thinking: false, fileProcessing: true } }),
    );
    modelsService.resolveChatModel.mockResolvedValue({
      id: 'model-1',
      name: 'Mock',
      provider: 'mock',
      capabilities: ['reasoning'],
    });

    await expect(
      service.assertChatTurnAllowed('user-1', 'conv-1', 'model-1', { content: 'سلام' }),
    ).rejects.toThrow(/تفکر عمیق/);
  });

  it('rejects file attachments when the plan lacks file processing', async () => {
    setup();
    entitlementsService.resolveForUser.mockResolvedValue(
      entitlement({ features: { webSearch: true, thinking: true, fileProcessing: false } }),
    );

    await expect(
      service.assertChatTurnAllowed('user-1', 'conv-1', undefined, { content: 'سلام' }, ['f1']),
    ).rejects.toThrow(/پیوست فایل/);
  });

  it('enforces the plan’s model allowlist on top of the free/premium rules', async () => {
    setup();
    entitlementsService.resolveForUser.mockResolvedValue(entitlement({ allowedModelIds: ['model-x'] }));

    await expect(
      service.assertChatTurnAllowed('user-1', 'conv-1', 'model-1', { content: 'سلام' }),
    ).rejects.toThrow(/این مدل در طرح فعلی شما مجاز نیست/);
  });

  it('admins bypass feature entitlements but not model allowlist/state checks', async () => {
    setup();
    // The global search switch is platform state (503 when off, admin
    // included); THIS test exercises the plan-feature bypass, so the switch
    // is on. The model must itself be web-search capable — capability is a
    // model-state check that admins do NOT bypass.
    webSearchService.isEnabled.mockReturnValue(true);
    modelsService.resolveChatModel.mockResolvedValue({
      id: 'model-1',
      name: 'Searcher',
      provider: 'mock',
      capabilities: ['web-search'],
    });
    entitlementsService.resolveForUser.mockResolvedValue(
      entitlement({
        tier: 'free',
        features: { webSearch: false, thinking: false, fileProcessing: false },
        allowedModelIds: ['model-1'],
      }),
    );

    // Feature gates are admin-bypassed (like quotas); the plan allowlist and
    // resolveChatModel checks still apply to admins.
    await expect(
      service.assertChatTurnAllowed('admin-1', 'conv-1', 'model-1', { content: 'سلام' }, [], true, true),
    ).resolves.toMatchObject({ plan: 'free' });

    entitlementsService.resolveForUser.mockResolvedValue(
      entitlement({ allowedModelIds: ['model-x'] }),
    );
    await expect(
      service.assertChatTurnAllowed('admin-1', 'conv-1', 'model-1', { content: 'سلام' }, [], true, true),
    ).rejects.toThrow(/این مدل در طرح فعلی شما مجاز نیست/);
  });

  it('skips the quota check for admins', async () => {
    setup();
    await service.assertChatTurnAllowed(
      'admin-1',
      'conv-1',
      undefined,
      { clientMessageId: undefined, content: 'سلام' },
      undefined,
      true,
    );
    expect(quotaService.assertQuota).not.toHaveBeenCalled();
  });

  it('skips the quota check for a replay (same clientMessageId + content)', async () => {
    setup({ existingUserByClientMid: { id: 'cmid-1', content: 'سلام' } });
    await service.assertChatTurnAllowed(
      'user-1',
      'conv-1',
      undefined,
      { clientMessageId: 'cmid-1', content: 'سلام' },
    );
    expect(quotaService.assertQuota).not.toHaveBeenCalled();
  });

  it('propagates a quota 429 from pre-flight as an HTTP exception', async () => {
    setup();
    quotaService.assertQuota.mockRejectedValue(
      new HttpException('سهمیه پیام‌های امروز شما تمام شده است.', HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(
      service.assertChatTurnAllowed('user-1', 'conv-1', undefined, {
        clientMessageId: undefined,
        content: 'سلام',
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('opens a usage row in the same step as the user row (fresh turns only)', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('ok');
    });

    const { handle, done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    await done;

    expect(usageService.recordTurnStart).toHaveBeenCalledTimes(1);
    const [manager, turn] = usageService.recordTurnStart.mock.calls[0];
    expect(turn).toMatchObject({
      userId: 'user-1',
      conversationId: 'conv-1',
      messageId: handle.userMessage.id,
      inputChars: expect.any(Number),
    });
    expect(turn.model).toMatchObject({ id: 'model-1' });
  });

  it('never opens a usage row on a replay (charged at most once)', async () => {
    setup({ existingUserByClientMid: { id: 'cmid-1', content: 'سلام' } });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('ok');
    });

    const { handle, done } = await begin('user-1', 'conv-1', 'سلام', undefined, 'cmid-1');
    await done;

    expect(handle.replay).toBe(true);
    expect(usageService.recordTurnStart).not.toHaveBeenCalled();
    // the terminal outcome still records against the ORIGINAL row
    expect(usageService.recordTurnEnd).toHaveBeenCalledWith(
      handle.userMessage.id,
      expect.objectContaining({ outcome: 'completed' }),
    );
  });

  it('records terminal usage with provider-reported tokens', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('سلام');
      yield { type: 'usage', inputTokens: 11, outputTokens: 22 } as ProviderEvent;
    });

    const { handle, done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    await done;

    // The usage row anchors to the USER message id (unique per turn) — the
    // terminal update must address the same key the insert used.
    expect(usageService.recordTurnEnd).toHaveBeenCalledWith(
      handle.userMessage.id,
      expect.objectContaining({
        outcome: 'completed',
        inputTokens: 11,
        outputTokens: 22,
        outputChars: 'سلام'.length,
      }),
    );
  });

  it('records a failed outcome when the provider dies (tokens still real)', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('پاسخ ناتمام');
      throw new ProviderError('unavailable', 503, 'provider down');
    });

    const { handle, done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    await done;

    expect(usageService.recordTurnEnd).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: 'failed', outputChars: 'پاسخ ناتمام'.length }),
    );
  });

  // ---- execution phases + provider fallback (day-7-8 contract §10/§12) ----

  const fallbackModel = { id: 'model-2', name: 'Fallback', provider: 'mock', capabilities: [] };
  const primaryWithFallback = {
    id: 'model-1',
    name: 'Primary',
    provider: 'mock',
    capabilities: [],
    fallbackModelId: 'model-2',
  };

  it('streams the phase lifecycle: meta → thinking → delta → generating → done', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('پاسخ');
    });

    const { done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events = await done;

    const statuses = events.filter(
      (e: ChatStreamEvent) => e.type === 'status',
    ) as Extract<ChatStreamEvent, { type: 'status' }>[];
    expect(statuses.map((s) => s.status)).toEqual(['thinking', 'generating']);
    // `thinking` precedes the first delta; `generating` precedes the delta it
    // announces (the text of the turn is appended after the phase flip).
    const firstDeltaIndex = events.findIndex((e: ChatStreamEvent) => e.type === 'delta');
    expect(events.findIndex((e: ChatStreamEvent) => e.type === 'status')).toBeLessThan(firstDeltaIndex);
    const generatingIndex = events.findIndex(
      (e: ChatStreamEvent) => e.type === 'status' && (e as any).status === 'generating',
    );
    expect(generatingIndex).toBeLessThan(firstDeltaIndex);
  });

  it('carries the server-decided webSearch flag on meta (plain turn: false)', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('پاسخ');
    });

    const { done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events = await done;
    expect(events[0]).toMatchObject({ type: 'meta', webSearch: false });
  });

  it('streams sources before the first delta on a search turn', async () => {
    setup();
    webSearchService.isEnabled.mockReturnValue(true);
    webSearchService.runForTurn.mockResolvedValue({
      sources: [{ title: 'T', url: 'https://x.dev/a', domain: 'x.dev', snippet: 's' }],
      contextBlock: '[نتایج]',
      warning: null,
    });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('پاسخ با منبع');
    });

    const { done } = await begin('user-1', 'conv-1', 'سوال', undefined, undefined, [], 'free', true);
    const events = await done;

    const order = events.map((e: ChatStreamEvent) => e.type);
    expect(order.indexOf('sources')).toBeGreaterThan(order.indexOf('search_completed'));
    expect(order.indexOf('sources')).toBeLessThan(order.indexOf('delta'));
    const sourcesEvent = events.find(
      (e: ChatStreamEvent) => e.type === 'sources',
    ) as Extract<ChatStreamEvent, { type: 'sources' }>;
    expect(sourcesEvent.sources).toHaveLength(1);
    // meta announces the search phase server-side.
    expect(events[0]).toMatchObject({ type: 'meta', webSearch: true });
  });

  it('rejects webSearch on a model without the web-search capability (400 pre-flight)', async () => {
    setup();
    webSearchService.isEnabled.mockReturnValue(true); // global switch on; capability is the gate under test
    await expect(
      service.assertChatTurnAllowed('user-1', 'conv-1', undefined, { content: 'سلام' }, [], false, true),
    ).rejects.toMatchObject({ status: 400, message: 'این مدل از جستجوی وب پشتیبانی نمی‌کند.' });
  });

  it('rejects webSearch with 503 while the platform search switch is off (pre-flight)', async () => {
    setup(); // isEnabled() === false — the global kill-switch wins over everything else
    await expect(
      service.assertChatTurnAllowed('user-1', 'conv-1', undefined, { content: 'سلام' }, [], false, true),
    ).rejects.toMatchObject({ status: 503, message: 'جستجوی وب فعال نیست.' });
  });

  it('accepts webSearch on a model WITH the web-search capability', async () => {
    setup();
    webSearchService.isEnabled.mockReturnValue(true);
    modelsService.resolveChatModel.mockResolvedValue({
      id: 'model-1',
      name: 'Searcher',
      provider: 'mock',
      capabilities: ['web-search'],
    });

    await expect(
      service.assertChatTurnAllowed('user-1', 'conv-1', undefined, { content: 'سلام' }, [], false, true),
    ).resolves.toMatchObject({ plan: 'free' });
  });

  it('returns the plan-scoped access facts from pre-flight for the fallback check', async () => {
    setup();
    const snapshot = entitlement({ allowedModelIds: ['model-1'] });
    entitlementsService.resolveForUser.mockResolvedValue(snapshot);

    const result = await service.assertChatTurnAllowed('user-1', 'conv-1', undefined, {
      content: 'سلام',
    });
    expect(result.access).toEqual({
      allowedModelIds: ['model-1'],
      features: snapshot.features,
    });
  });

  it('falls back once on a retryable pre-delta failure and answers with the fallback model', async () => {
    setup();
    modelsService.resolveChatModel.mockResolvedValue(primaryWithFallback);
    modelsService.resolveFallbackCandidate.mockResolvedValue(fallbackModel);
    let call = 0;
    aiProviderService.streamChat.mockImplementation(async function* () {
      if (call++ === 0) {
        throw new ProviderError('unavailable', 503, 'provider 1 down');
      }
      yield text('پاسخ از مدل جایگزین');
    });

    const { done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events = await done;

    // The terminal row is attributed to the fallback model.
    const terminal = events.at(-1) as Extract<ChatStreamEvent, { type: 'done' }>;
    expect(terminal.type).toBe('done');
    expect(terminal.assistantMessage).toMatchObject({
      status: 'completed',
      modelId: 'model-2',
      content: 'پاسخ از مدل جایگزین',
    });

    // The switch is announced exactly once with the fallback detail.
    const fallbackStatuses = events.filter(
      (e: ChatStreamEvent) => e.type === 'status' && (e as any).detail === 'fallback',
    );
    expect(fallbackStatuses).toHaveLength(1);

    // Exactly two provider attempts, no duplicated text (INV-9).
    expect(aiProviderService.streamChat).toHaveBeenCalledTimes(2);

    // The persisted assistant row AND the usage row attribute to the model
    // that actually answered (contract §22.6).
    const finalRow = messagesRepository.saved
      .filter((row: any) => row.role === 'assistant')
      .at(-1);
    expect(finalRow).toMatchObject({ status: 'completed', modelId: 'model-2' });
    expect(messagesRepository.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ modelId: 'model-2' }),
    );
    expect(usageService.recordFallbackModel).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ id: 'model-2' }),
    );
  });

  it('never falls back after the first delta (partial output is never discarded)', async () => {
    setup();
    modelsService.resolveChatModel.mockResolvedValue(primaryWithFallback);
    modelsService.resolveFallbackCandidate.mockResolvedValue(fallbackModel);
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('نیمه‌تمام ');
      throw new ProviderError('timeout', null, 'died mid-stream');
    });

    const { done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events = await done;

    expect(aiProviderService.streamChat).toHaveBeenCalledTimes(1);
    expect(modelsService.resolveFallbackCandidate).not.toHaveBeenCalled();
    const terminal = events.at(-1) as Extract<ChatStreamEvent, { type: 'failed' }>;
    expect(terminal.type).toBe('failed');
    // Partial content is preserved honestly.
    expect(terminal.assistantMessage).toMatchObject({ status: 'failed', content: 'نیمه‌تمام ' });
  });

  it('never falls back on non-retryable failures (auth/invalid-config fail fast)', async () => {
    setup();
    modelsService.resolveChatModel.mockResolvedValue(primaryWithFallback);
    modelsService.resolveFallbackCandidate.mockResolvedValue(fallbackModel);
    aiProviderService.streamChat.mockImplementation(async function* () {
      throw new ProviderError('auth', 401, 'bad api key');
    });

    const { done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events = await done;

    expect(aiProviderService.streamChat).toHaveBeenCalledTimes(1);
    expect(modelsService.resolveFallbackCandidate).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('failed');
  });

  it('fails the turn when the fallback candidate cannot serve the caller', async () => {
    setup();
    modelsService.resolveChatModel.mockResolvedValue(primaryWithFallback);
    modelsService.resolveFallbackCandidate.mockResolvedValue(null); // inactive/not allowed
    aiProviderService.streamChat.mockImplementation(async function* () {
      throw new ProviderError('rate-limit', 429, 'slow down');
    });

    const { done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events = await done;

    expect(aiProviderService.streamChat).toHaveBeenCalledTimes(1);
    expect(usageService.recordFallbackModel).not.toHaveBeenCalled();
    const terminal = events.at(-1) as Extract<ChatStreamEvent, { type: 'failed' }>;
    expect(terminal.type).toBe('failed');
    expect(terminal.clientMessage).toContain('موقتاً در دسترس نیست');
  });

  it('can never loop A→B→A: the fallback of the fallback is refused', async () => {
    setup();
    modelsService.resolveChatModel.mockResolvedValue(primaryWithFallback);
    // B answers for a while... then B ALSO fails retryably; B's fallback is A
    // (the model already attempted) — the attempted-set must block the hop.
    modelsService.resolveFallbackCandidate
      .mockResolvedValueOnce({ ...fallbackModel, fallbackModelId: 'model-1' })
      .mockResolvedValueOnce({ ...primaryWithFallback });
    let call = 0;
    aiProviderService.streamChat.mockImplementation(async function* () {
      if (call++ < 2) {
        throw new ProviderError('unavailable', 503, `provider ${call} down`);
      }
      yield text('نباید برسد');
    });

    const { done } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events = await done;

    expect(aiProviderService.streamChat).toHaveBeenCalledTimes(2);
    const terminal = events.at(-1) as Extract<ChatStreamEvent, { type: 'failed' }>;
    expect(terminal.type).toBe('failed');
    expect(terminal.assistantMessage).toMatchObject({ status: 'failed', content: '' });
  });
});

describe('MessagesService — reconnect / recovery', () => {
  let service: MessagesService;
  let registry: GenerationRegistry;
  let messagesRepository: ReturnType<typeof createMockRepository>;
  let conversationsService: any;
  let modelsService: any;
  let aiProviderService: { streamChat: jest.Mock };
  let filesService: { getReadyContext: jest.Mock };
  let webSearchService: { isEnabled: jest.Mock; runForTurn: jest.Mock };
  let entitlementsService: { resolveForUser: jest.Mock };
  let quotaService: { assertQuota: jest.Mock };
  let usageService: {
    recordTurnStart: jest.Mock;
    recordTurnEnd: jest.Mock;
    recordFallbackModel: jest.Mock;
  };

  const setup = ({ history = [] }: { history?: any[] } = {}) => {
    conversationsService = {
      getOwned: jest.fn(),
      getOwnedWithMessages: jest.fn().mockResolvedValue({
        conversation: { id: 'conv-1', userId: 'user-1', title: 'ت' },
        messages: history,
      }),
      renameTitle: jest.fn(),
    };
    modelsService = {
      resolveChatModel: jest.fn().mockResolvedValue({ id: 'model-1', name: 'Mock', provider: 'mock', capabilities: [] }),
      // Only consulted when a model actually declares a fallback AND the
      // provider failed with a retryable kind before the first delta.
      resolveFallbackCandidate: jest.fn().mockResolvedValue(null),
    };
    messagesRepository = createMockRepository();
    filesService = { getReadyContext: jest.fn().mockResolvedValue([]) };
    // Web search is opt-in and disabled by default in every existing test —
    // plain turns must never touch it (Invariant 1 regression net).
    webSearchService = {
      isEnabled: jest.fn().mockReturnValue(false),
      runForTurn: jest.fn(),
    };

    // Entitlement/quota/usage collaborators default to the permissive path.
    entitlementsService = { resolveForUser: jest.fn().mockResolvedValue(entitlement()) };
    quotaService = { assertQuota: jest.fn().mockResolvedValue(undefined) };
    usageService = {
      recordTurnStart: jest.fn().mockResolvedValue(undefined),
      recordTurnEnd: jest.fn().mockResolvedValue(undefined),
      recordFallbackModel: jest.fn().mockResolvedValue(undefined),
    };
    registry = new GenerationRegistry();
    service = new MessagesService(
      messagesRepository as any,
      conversationsService as any,
      modelsService as any,
      aiProviderService as any,
      registry,
      { get: () => 60_000 } as any,
      filesService as any,
      webSearchService as any,
      entitlementsService as any,
      quotaService as any,
      usageService as any,
    );
  };

  beforeEach(() => {
    aiProviderService = { streamChat: jest.fn() };
  });

  it('replays a COMPLETED row as snapshot + done without ever invoking the AI', async () => {
    const completedRow = {
      id: 'assistant-1',
      conversationId: 'conv-1',
      role: 'assistant' as const,
      content: 'پاسخ کامل',
      status: 'completed',
      errorMessage: null,
      modelId: 'model-1',
      clientMessageId: null,
      createdAt: new Date(),
    };
    setup({ history: [completedRow] });

    const events: ChatStreamEvent[] = [];
    for await (const event of service.reconnectGeneration('user-1', 'conv-1', 'assistant-1')) {
      events.push(event);
    }

    expect(aiProviderService.streamChat).not.toHaveBeenCalled();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'snapshot', assistantMessage: { content: 'پاسخ کامل' } });
    expect(events[1]).toMatchObject({ type: 'done', assistantMessage: { content: 'پاسخ کامل' } });
  });

  it('honestly marks an ORPHANED pending row interrupted (server restart case)', async () => {
    const orphanedRow = {
      id: 'assistant-9',
      conversationId: 'conv-1',
      role: 'assistant' as const,
      content: 'نیمه‌کاره',
      status: 'streaming',
      errorMessage: null,
      modelId: 'model-1',
      clientMessageId: null,
      createdAt: new Date(),
    };
    setup({ history: [orphanedRow] });
    // No registry.register() → the generation is not live in this process.

    const events: ChatStreamEvent[] = [];
    for await (const event of service.reconnectGeneration('user-1', 'conv-1', 'assistant-9')) {
      events.push(event);
    }

    const persisted = messagesRepository.saved.at(-1);
    expect(persisted).toMatchObject({ id: 'assistant-9', status: 'interrupted' });
    expect(events[0]).toMatchObject({ type: 'snapshot', assistantMessage: { status: 'interrupted' } });
    const terminal = events.at(-1) as Extract<ChatStreamEvent, { type: 'failed' }>;
    expect(terminal.clientMessage).toContain('ناتمام ماند');
    // Internal note stays server-side.
    expect(terminal.clientMessage).not.toContain('server restart');
  });

  it('reconnects to a LIVE generation: snapshot + only the REMAINING deltas, no duplicates', async () => {
    setup();
    const chunks = ['الف ', 'ب ', 'ج ', 'د ', 'ه'];
    aiProviderService.streamChat.mockImplementation(async function* () {
      for (const chunk of chunks) {
        await sleep(25);
        yield text(chunk);
      }
    });

    // Tab A starts the turn and leaves after the first delta.
    const handle = await service.beginChatTurn('user-1', 'conv-1', 'سلام', undefined, undefined);
    // The reconnect path re-reads the conversation: expose the freshly
    // created rows through the mocked conversation lookup.
    conversationsService.getOwnedWithMessages.mockResolvedValue({
      conversation: { id: 'conv-1', userId: 'user-1', title: 'ت' },
      messages: [handle.userMessage, handle.assistantMessage],
    });
    for await (const event of handle.events) {
      if (event.type === 'delta') break;
    }

    // Tab B reconnects to the same generation while it is still live.
    const reconnectDeltas: string[] = [];
    let snapshot = '';
    for await (const event of service.reconnectGeneration('user-1', 'conv-1', handle.assistantMessage.id)) {
      if (event.type === 'snapshot') snapshot = event.assistantMessage.content;
      else if (event.type === 'delta') reconnectDeltas.push(event.text);
      else if (event.type === 'done') break;
    }

    const finalRow = await handle.completion;
    // The classic ChatGPT invariant: previous text is shown, then only the
    // remainder streams — snapshot + deltas must equal the exact answer.
    expect(snapshot.length).toBeGreaterThan(0);
    expect(snapshot + reconnectDeltas.join('')).toBe(finalRow.content);
    expect(finalRow.status).toBe('completed');
    // And no AI re-invocation happened: one generation, one provider stream.
    expect(aiProviderService.streamChat).toHaveBeenCalledTimes(1);
  });

  it('rejects reconnect for a message that does not belong to the caller', async () => {
    setup({ history: [] });

    await expect(
      service.assertReconnectAllowed('user-1', 'conv-1', 'missing-message'),
    ).rejects.toThrow(NotFoundException);
  });
});


describe('MessagesService — Stop (user-initiated cancellation)', () => {
  let service: MessagesService;
  let registry: GenerationRegistry;
  let messagesRepository: ReturnType<typeof createMockRepository>;
  let conversationsService: {
    getOwned: jest.Mock;
    getOwnedWithMessages: jest.Mock;
    renameTitle: jest.Mock;
  };
  let modelsService: { resolveChatModel: jest.Mock; resolveFallbackCandidate: jest.Mock };
  let aiProviderService: { streamChat: jest.Mock };
  let filesService: { getReadyContext: jest.Mock };
  let webSearchService: { isEnabled: jest.Mock; runForTurn: jest.Mock };
  let entitlementsService: { resolveForUser: jest.Mock };
  let quotaService: { assertQuota: jest.Mock };
  let usageService: {
    recordTurnStart: jest.Mock;
    recordTurnEnd: jest.Mock;
    recordFallbackModel: jest.Mock;
  };

  const setup = () => {
    conversationsService = {
      getOwned: jest.fn().mockResolvedValue({ id: 'conv-1', userId: 'user-1', title: 'گفتگو' }),
      getOwnedWithMessages: jest.fn().mockResolvedValue({
        conversation: { id: 'conv-1', userId: 'user-1', title: 'گفتگو' },
        messages: [],
      }),
      renameTitle: jest.fn().mockResolvedValue(undefined),
    };
    modelsService = {
      resolveChatModel: jest.fn().mockResolvedValue({
        id: 'model-1',
        name: 'Mock',
        provider: 'mock',
        capabilities: [],
      }),
      resolveFallbackCandidate: jest.fn().mockResolvedValue(null),
    };
    messagesRepository = createMockRepository();
    const configService = { get: () => undefined };
    filesService = { getReadyContext: jest.fn().mockResolvedValue([]) };
    webSearchService = {
      isEnabled: jest.fn().mockReturnValue(false),
      runForTurn: jest.fn(),
    };
    entitlementsService = { resolveForUser: jest.fn().mockResolvedValue(undefined) };
    quotaService = { assertQuota: jest.fn().mockResolvedValue(undefined) };
    usageService = {
      recordTurnStart: jest.fn().mockResolvedValue(undefined),
      recordTurnEnd: jest.fn().mockResolvedValue(undefined),
      recordFallbackModel: jest.fn().mockResolvedValue(undefined),
    };
    registry = new GenerationRegistry();
    service = new MessagesService(
      messagesRepository as any,
      conversationsService as any,
      modelsService as any,
      aiProviderService as any,
      registry,
      configService as any,
      filesService as any,
      webSearchService as any,
      entitlementsService as any,
      quotaService as any,
      usageService as any,
    );
  };

  /** Starts a turn and consumes its event feed in the background. */
  async function begin(): Promise<{
    handle: ChatTurnHandle;
    events: ChatStreamEvent[];
    done: Promise<ChatStreamEvent[]>;
  }> {
    const handle = await service.beginChatTurn('user-1', 'conv-1', 'سلام', undefined, undefined);
    const events: ChatStreamEvent[] = [];
    const done = (async () => {
      for await (const event of handle.events) {
        events.push(event);
      }
      return events;
    })();
    return { handle, events, done };
  }

  beforeEach(() => {
    aiProviderService = { streamChat: jest.fn() };
  });

  it('aborts the provider stream and persists the partial row as interrupted (never completed/failed)', async () => {
    setup();
    let releaseSecond!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('بخش اول. ');
      await gate;
      yield text('این بخش بعد از توقف است');
    });

    const { handle, done } = await begin();
    // Wait until the first delta is published, then stop the turn.
    await sleep(20);
    const assistantRow = handle.assistantMessage;
    // Only the assistant row is open (pending/streaming) in the DB.
    messagesRepository.find.mockResolvedValue([assistantRow]);

    const stopPromise = service.stopConversationGeneration('user-1', 'conv-1');
    releaseSecond(); // the provider "sends" one more token after the abort
    const result = await stopPromise;
    const events = await done;

    expect(result.stopped).toBe(true);
    // The authoritative final row: partial content only, honest status.
    expect(result.message).toMatchObject({
      id: assistantRow.id,
      status: 'interrupted',
      content: 'بخش اول. ',
      errorMessage: null,
    });
    // Tokens after cancellation never mutated the persisted message.
    const finalRow = messagesRepository.saved
      .filter((row: any) => row.role === 'assistant')
      .at(-1);
    expect(finalRow).toMatchObject({ status: 'interrupted', content: 'بخش اول. ' });
    // Terminal event on the feed is `cancelled`, not `failed`/`done`.
    expect(events.at(-1)).toMatchObject({
      type: 'cancelled',
      assistantMessage: { status: 'interrupted' },
    });
    // Usage: exactly one terminal update, interrupted (tokens were consumed).
    expect(usageService.recordTurnEnd).toHaveBeenCalledTimes(1);
    expect(usageService.recordTurnEnd).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: 'interrupted' }),
    );
    // The generation is no longer live in the registry.
    expect(registry.isLive(assistantRow.id)).toBe(false);
  });

  it('hands a cancellation signal to the provider stream (abort propagation)', async () => {
    setup();
    let signalStateAtCall: boolean | null = null;
    let receivedSignal: AbortSignal | undefined;
    aiProviderService.streamChat.mockImplementation(async function* (
      _history: unknown,
      _model: unknown,
      signal?: AbortSignal,
    ) {
      receivedSignal = signal;
      signalStateAtCall = signal?.aborted ?? null;
      yield text('متن');
      // Simulate the real adapter: an abort mid-read surfaces as an error.
      if (signal?.aborted) throw new ProviderError('cancelled', null, 'cancelled');
      await sleep(50);
      yield text(' بیشتر');
    });

    const { handle, done } = await begin();
    await sleep(10);
    messagesRepository.find.mockResolvedValue([handle.assistantMessage]);
    await service.stopConversationGeneration('user-1', 'conv-1');
    const events = await done;

    // streamChat received a live (non-aborted) signal at call time…
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(signalStateAtCall).toBe(false);
    // …the stop aborted that very signal, and the turn ended interrupted.
    expect(receivedSignal!.aborted).toBe(true);
    const finalRow = await handle.completion;
    expect(finalRow.status).toBe('interrupted');
    expect(events.at(-1)?.type).toBe('cancelled');
  });

  it('never routes a cancelled turn into the fallback (a stop stays stopped)', async () => {
    setup();
    // The primary model declares a fallback, and the provider stream dies
    // with a cancellation (what an aborted adapter surfaces).
    modelsService.resolveChatModel.mockResolvedValue({
      id: 'model-1',
      name: 'Primary',
      provider: 'mock',
      capabilities: [],
      fallbackModelId: 'model-2',
    });
    modelsService.resolveFallbackCandidate.mockResolvedValue({
      id: 'model-2',
      name: 'Fallback',
      provider: 'mock',
      capabilities: [],
    });
    aiProviderService.streamChat.mockImplementation(async function* () {
      throw new ProviderError('cancelled', null, 'cancelled before first delta');
    });

    const { handle, done } = await begin();
    const finalRow = await handle.completion;
    const events = await done;

    expect(finalRow.status).toBe('interrupted');
    expect(finalRow.modelId).toBe('model-1'); // never re-attributed
    expect(modelsService.resolveFallbackCandidate).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe('cancelled');
  });

  it('resolves the stop-vs-completion race deterministically: abort before the final write wins', async () => {
    setup();
    let releaseEnd!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('همه توکن‌ها ');
      await gate; // stream not finished yet
    });

    const { handle, done } = await begin();
    await sleep(20);
    messagesRepository.find.mockResolvedValue([handle.assistantMessage]);
    // Stop arrives AFTER the last token but BEFORE the stream ends.
    const stopPromise = service.stopConversationGeneration('user-1', 'conv-1');
    releaseEnd();
    const result = await stopPromise;
    await done;

    expect(result.message).toMatchObject({ status: 'interrupted' });
    const finalRow = await handle.completion;
    expect(finalRow.status).toBe('interrupted'); // never 'completed'
  });

  it('leaves a naturally completed turn alone (cancellation after completion is a no-op)', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('پاسخ کامل');
    });

    const { handle, done } = await begin();
    await done; // generation fully terminal before the stop arrives

    // The completed row is no longer open, so the lookup finds nothing.
    messagesRepository.find.mockResolvedValue([]);
    const result = await service.stopConversationGeneration('user-1', 'conv-1');

    expect(result.stopped).toBe(false);
    expect(result.message).toBeNull();
    const finalRow = await handle.completion;
    expect(finalRow.status).toBe('completed');
    // No second terminal usage update.
    expect(usageService.recordTurnEnd).toHaveBeenCalledTimes(1);
    expect(usageService.recordTurnEnd).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: 'completed' }),
    );
  });

  it('is idempotent and safe when nothing is generating (no active generation)', async () => {
    setup();
    messagesRepository.find.mockResolvedValue([]);

    const result = await service.stopConversationGeneration('user-1', 'conv-1');

    expect(result).toEqual({ stopped: false, message: null });
    expect(messagesRepository.save).not.toHaveBeenCalled();
    expect(usageService.recordTurnEnd).not.toHaveBeenCalled();
  });

  it('marks an orphaned pending/streaming row interrupted so a deliberate stop stays stopped', async () => {
    setup();
    const orphan = {
      id: 'assistant-orphan',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'ناتمام',
      status: 'streaming',
      errorMessage: null,
    };
    messagesRepository.find.mockResolvedValue([orphan]);

    const result = await service.stopConversationGeneration('user-1', 'conv-1');

    expect(result.stopped).toBe(true);
    expect(result.message).toMatchObject({ id: 'assistant-orphan', status: 'interrupted' });
    expect(orphan.status).toBe('interrupted');
    expect(messagesRepository.save).toHaveBeenCalledWith(orphan);
    expect(usageService.recordTurnEnd).toHaveBeenCalledWith(
      'assistant-orphan',
      expect.objectContaining({ outcome: 'interrupted' }),
    );
  });

  it('rejects a stop for a conversation the caller does not own', async () => {
    setup();
    conversationsService.getOwned.mockRejectedValue(new NotFoundException('یافت نشد.'));

    await expect(service.stopConversationGeneration('user-2', 'conv-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(messagesRepository.find).not.toHaveBeenCalled();
  });

  it('still completes after a client DISCONNECT (disconnect is not a cancellation)', async () => {
    setup();
    const chunks = ['الف ', 'ب ', 'پ'];
    aiProviderService.streamChat.mockImplementation(async function* () {
      for (const chunk of chunks) {
        await sleep(10);
        yield text(chunk);
      }
    });

    const { handle } = await begin();
    // Consume one delta, then break (client left) — must NOT stop the turn.
    for await (const event of handle.events) {
      if (event.type === 'delta') break;
    }

    const finalRow = await handle.completion;
    expect(finalRow.status).toBe('completed');
    expect(finalRow.content).toBe(chunks.join(''));
  });
});
