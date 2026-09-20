import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { Conversation } from './conversation.entity';
import { createMockRepository } from '../test/mocks';

describe('ConversationsService', () => {
  let service: ConversationsService;
  let repository: ReturnType<typeof createMockRepository>;
  let modelsService: { resolveChatModel: jest.Mock };
  let entitlementsService: { resolveForUser: jest.Mock };

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

  beforeEach(() => {
    repository = createMockRepository();
    modelsService = {
      // Same chokepoint a chat send uses; default resolves the requested id.
      resolveChatModel: jest.fn().mockImplementation(async (modelId: string) => ({
        id: modelId,
        capabilities: [],
      })),
    };
    entitlementsService = { resolveForUser: jest.fn().mockResolvedValue(entitlement()) };
    service = new ConversationsService(
      repository as any,
      modelsService as any,
      entitlementsService as any,
    );
  });

  it('creates a conversation for the given owner only', async () => {
    repository.save.mockImplementation(async (data: any) => ({ id: 'conv-1', ...data }));

    const conversation = await service.create('user-1', { title: '  سلام  ' });
    expect(conversation.userId).toBe('user-1');
    expect(conversation.title).toBe('سلام');
  });

  it('falls back to the default title for an empty one', async () => {
    repository.save.mockImplementation(async (data: any) => ({ id: 'conv-1', ...data }));
    const conversation = await service.create('user-1', {});
    expect(conversation.title).toBe('گفتگوی جدید');
  });

  it("returns a conversation to its owner", async () => {
    repository.findOne.mockResolvedValue({ id: 'conv-1', userId: 'user-1' } as Conversation);
    const conversation = await service.getOwned('user-1', 'conv-1');
    expect(conversation.id).toBe('conv-1');
  });

  it('hides other users’ conversations behind 404 (no existence leak)', async () => {
    // Model the DB honestly: the where clause filters on both id and userId.
    repository.findOne.mockImplementation(async (options: any) =>
      options.where.id === 'conv-1' && options.where.userId === 'user-B'
        ? { id: 'conv-1', userId: 'user-B' }
        : null,
    );
    await expect(service.getOwned('user-A', 'conv-1')).rejects.toThrow(NotFoundException);
  });

  it('rejects unknown conversation ids with 404', async () => {
    repository.findOne.mockResolvedValue(null);
    await expect(service.getOwned('user-1', 'missing')).rejects.toThrow(NotFoundException);
  });
});

describe('ConversationsService — setModel (selected-model persistence)', () => {
  let service: ConversationsService;
  let repository: ReturnType<typeof createMockRepository>;
  let modelsService: { resolveChatModel: jest.Mock };
  let entitlementsService: { resolveForUser: jest.Mock };

  const ownedConversation: Record<string, unknown> = {
    id: 'conv-1',
    userId: 'user-1',
    modelId: null,
  };

  const setup = ({
    conversation = ownedConversation,
    entitlementSnapshot = undefined as Record<string, unknown> | undefined,
    resolveChatModel = undefined as jest.Mock | undefined,
  }: {
    conversation?: Record<string, unknown> | null;
    entitlementSnapshot?: Record<string, unknown>;
    resolveChatModel?: jest.Mock;
  } = {}) => {
    repository = createMockRepository();
    repository.findOne.mockResolvedValue(conversation);
    modelsService = { resolveChatModel: resolveChatModel ?? jest.fn() };
    entitlementsService = {
      resolveForUser: jest.fn().mockResolvedValue(entitlementSnapshot ?? entitlementFree()),
    };
    service = new ConversationsService(
      repository as any,
      modelsService as any,
      entitlementsService as any,
    );
  };

  const entitlementFree = (overrides: Record<string, unknown> = {}) => ({
    tier: 'free' as const,
    features: { webSearch: true, thinking: true, fileProcessing: true },
    allowedModelIds: null,
    ...overrides,
  });

  it('persists an explicitly selected model on the owned conversation', async () => {
    setup();
    modelsService.resolveChatModel.mockResolvedValue({ id: 'model-b', capabilities: [] });

    const updated = await service.setModel('user-1', 'conv-1', 'model-b');

    expect(modelsService.resolveChatModel).toHaveBeenCalledWith('model-b', 'free');
    // The whole entity is saved, so the update rides the owned row.
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'conv-1', modelId: 'model-b' }),
    );
    expect(updated.modelId).toBe('model-b');
  });

  it('persists per conversation: another caller cannot select on a foreign conversation', async () => {
    setup({ conversation: null }); // where(id + userId) misses → hidden
    await expect(service.setModel('user-A', 'conv-1', 'model-b')).rejects.toThrow(
      NotFoundException,
    );
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('rejects an unknown model id like a send would (404)', async () => {
    setup();
    modelsService.resolveChatModel.mockRejectedValue(new NotFoundException('مدل درخواستی پیدا نشد.'));

    await expect(service.setModel('user-1', 'conv-1', 'model-x')).rejects.toThrow(NotFoundException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('rejects an inactive model like a send would (400)', async () => {
    setup();
    modelsService.resolveChatModel.mockRejectedValue(
      new BadRequestException('این مدل غیرفعال است و قابل استفاده نیست.'),
    );

    await expect(service.setModel('user-1', 'conv-1', 'model-off')).rejects.toThrow(
      BadRequestException,
    );
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('rejects a model outside the plan allowlist (403), mirroring assertChatTurnAllowed', async () => {
    setup({ entitlementSnapshot: entitlementFree({ allowedModelIds: ['model-a'] }) });
    modelsService.resolveChatModel.mockResolvedValue({ id: 'model-b', capabilities: [] });

    await expect(service.setModel('user-1', 'conv-1', 'model-b')).rejects.toThrow(ForbiddenException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('rejects a reasoning model for a plan without the thinking feature (403)', async () => {
    setup({
      entitlementSnapshot: entitlementFree({ features: { webSearch: true, thinking: false, fileProcessing: true } }),
    });
    modelsService.resolveChatModel.mockResolvedValue({ id: 'model-r', capabilities: ['reasoning'] });

    await expect(service.setModel('user-1', 'conv-1', 'model-r')).rejects.toThrow(ForbiddenException);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('lets an admin select a reasoning model without the thinking feature', async () => {
    setup({
      entitlementSnapshot: entitlementFree({ features: { webSearch: true, thinking: false, fileProcessing: true } }),
    });
    modelsService.resolveChatModel.mockResolvedValue({ id: 'model-r', capabilities: ['reasoning'] });

    const updated = await service.setModel('admin-1', 'conv-1', 'model-r', true);
    expect(updated.modelId).toBe('model-r');
  });

  it('clears the selection with null without consulting model validation', async () => {
    setup({ conversation: { id: 'conv-1', userId: 'user-1', modelId: 'model-b' } });

    const updated = await service.setModel('user-1', 'conv-1', null);

    expect(modelsService.resolveChatModel).not.toHaveBeenCalled();
    expect(entitlementsService.resolveForUser).not.toHaveBeenCalled();
    expect(updated.modelId).toBeNull();
  });

  it('rejects a body without the modelId key (no silent no-op or accidental clear)', async () => {
    setup();
    await expect(service.setModel('user-1', 'conv-1', undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(repository.save).not.toHaveBeenCalled();
  });
});
