import { NotFoundException } from '@nestjs/common';
import { GenerationRegistry } from './generation.registry';
import { MessagesService, ChatStreamEvent, ChatTurnHandle } from './messages.service';
import { createMockRepository } from '../test/mocks';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  const setup = ({
    history = [],
    title = 'گفتگوی جدید',
    persistIntervalMs = 60_000,
    existingUserByClientMid = null,
  }: {
    history?: { role: 'user' | 'assistant'; content: string }[];
    title?: string;
    persistIntervalMs?: number;
    existingUserByClientMid?: { id: string; content: string } | null;
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

    registry = new GenerationRegistry();
    service = new MessagesService(
      messagesRepository as any,
      conversationsService as any,
      modelsService as any,
      aiProviderService as any,
      registry,
      configService as any,
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
      yield 'سلام ';
      yield 'دنیا';
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
      yield 'سلام ';
      yield 'دنیا';
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
      yield 'پاسخ ناتمام';
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
        yield chunk;
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
      yield 'تنها بخش پاسخ';
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

  it('marks the row failed (not interrupted) on provider timeout even with no subscribers', async () => {
    setup();
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield 'قدیم ';
      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      throw abort;
    });

    const { handle } = await begin('user-1', 'conv-1', 'سلام', undefined, undefined);
    const finalRow = await handle.completion;
    expect(finalRow.status).toBe('failed');
    expect(finalRow.errorMessage).toContain('timed out');
  });

  it('persists incremental progress while streaming (throttled, not per token)', async () => {
    setup({ persistIntervalMs: 5 });
    const chunks = ['یک ', 'دو ', 'سه ', 'چهار ', 'پنج'];
    aiProviderService.streamChat.mockImplementation(async function* () {
      for (const chunk of chunks) {
        await sleep(20); // long enough that the 5ms interval elapses repeatedly
        yield chunk;
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
      yield 'اول';
      yield 'دوم';
    });

    await begin('user-1', 'conv-1', 'سلام', undefined, undefined);

    const firstPersist = messagesRepository.update.mock.calls[0]?.[1] as any;
    expect(firstPersist).toMatchObject({ status: 'streaming', content: 'اول' });
  });

  it('names the conversation after its first message', async () => {
    setup({ title: 'گفتگوی جدید' });
    aiProviderService.streamChat.mockImplementation(async function* () {
      yield 'ok';
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
      yield 'ok';
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
      yield 'ok';
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
      yield 'پاسخ دوم';
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
      yield 'ok';
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
      yield 'ok';
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
      yield 'ok';
    });

    const { handle, done } = await begin('user-1', 'conv-1', 'سلام', undefined, 'brand-new');
    await done;

    expect(handle.userMessage).toMatchObject({ content: 'سلام', clientMessageId: 'brand-new' });
    expect(handle.replay).toBe(false);
  });
});

describe('MessagesService — reconnect / recovery', () => {
  let service: MessagesService;
  let registry: GenerationRegistry;
  let messagesRepository: ReturnType<typeof createMockRepository>;
  let conversationsService: any;
  let modelsService: any;
  let aiProviderService: { streamChat: jest.Mock };

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
    registry = new GenerationRegistry();
    service = new MessagesService(
      messagesRepository as any,
      conversationsService as any,
      modelsService as any,
      aiProviderService as any,
      registry,
      { get: () => 60_000 } as any,
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
        yield chunk;
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
