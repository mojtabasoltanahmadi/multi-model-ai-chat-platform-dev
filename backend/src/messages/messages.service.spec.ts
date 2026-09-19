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

describe('MessagesService — chat turn lifecycle', () => {
  let service: MessagesService;
  let registry: GenerationRegistry;
  let messagesRepository: ReturnType<typeof createMockRepository>;
  let conversationsService: {
    getOwned: jest.Mock;
    getOwnedWithMessages: jest.Mock;
    renameTitle: jest.Mock;
  };
  let modelsService: { resolveChatModel: jest.Mock };
  let aiProviderService: { streamChat: jest.Mock };
  let filesService: { getReadyContext: jest.Mock };
  let webSearchService: { isEnabled: jest.Mock; runForTurn: jest.Mock };
  let usersService: { getPlan: jest.Mock };
  let quotaService: { assertQuota: jest.Mock };
  let usageService: { recordTurnStart: jest.Mock; recordTurnEnd: jest.Mock };

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
      resolveChatModel: jest.fn().mockResolvedValue({ id: 'model-1', name: 'Mock', provider: 'mock' }),
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

    // Plan/quota/usage collaborators default to the permissive path.
    usersService = { getPlan: jest.fn().mockResolvedValue('free') };
    quotaService = { assertQuota: jest.fn().mockResolvedValue(undefined) };
    usageService = { recordTurnStart: jest.fn().mockResolvedValue(undefined), recordTurnEnd: jest.fn().mockResolvedValue(undefined) };

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
      usersService as any,
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

  it('checks the caller quota pre-flight and resolves the model against the fresh plan', async () => {
    setup();
    usersService.getPlan.mockResolvedValue('premium');

    await service.assertChatTurnAllowed('user-1', 'conv-1', undefined, {
      clientMessageId: undefined,
      content: 'سلام',
    });

    expect(usersService.getPlan).toHaveBeenCalledWith('user-1');
    expect(quotaService.assertQuota).toHaveBeenCalledWith('user-1', 'premium');
    expect(modelsService.resolveChatModel).toHaveBeenCalledWith(undefined, 'premium');
  });

  it('beginChatTurn resolves the model against the plan handed down from pre-flight', async () => {
    setup();
    usersService.getPlan.mockResolvedValue('premium');
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield text('ok');
    });

    await begin('user-1', 'conv-1', 'سلام', undefined, undefined, [], 'premium');

    // the second resolve (turn creation) uses the SAME plan, not a hard-code
    expect(modelsService.resolveChatModel).toHaveBeenLastCalledWith(undefined, 'premium');
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
  let usersService: { getPlan: jest.Mock };
  let quotaService: { assertQuota: jest.Mock };
  let usageService: { recordTurnStart: jest.Mock; recordTurnEnd: jest.Mock };

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
      resolveChatModel: jest.fn().mockResolvedValue({ id: 'model-1', name: 'Mock', provider: 'mock' }),
    };
    messagesRepository = createMockRepository();
    filesService = { getReadyContext: jest.fn().mockResolvedValue([]) };
    // Web search is opt-in and disabled by default in every existing test —
    // plain turns must never touch it (Invariant 1 regression net).
    webSearchService = {
      isEnabled: jest.fn().mockReturnValue(false),
      runForTurn: jest.fn(),
    };

    // Plan/quota/usage collaborators default to the permissive path.
    usersService = { getPlan: jest.fn().mockResolvedValue('free') };
    quotaService = { assertQuota: jest.fn().mockResolvedValue(undefined) };
    usageService = { recordTurnStart: jest.fn().mockResolvedValue(undefined), recordTurnEnd: jest.fn().mockResolvedValue(undefined) };
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
      usersService as any,
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
