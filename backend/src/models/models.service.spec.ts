import { ModelsService } from './models.service';
import { createMockRepository } from '../test/mocks';

describe('ModelsService', () => {
  let service: ModelsService;
  let repository: ReturnType<typeof createMockRepository>;

  const model = (overrides: Partial<any> = {}) => ({
    id: 'model-1',
    name: 'Mock GPT',
    provider: 'mock',
    externalModelId: 'mock-1',
    baseUrl: null,
    apiKey: 'sk-secret',
    isActive: true,
    isFree: true,
    isDefault: false,
    ...overrides,
  });

  beforeEach(() => {
    repository = createMockRepository();
    service = new ModelsService(repository as any);
  });

  describe('create', () => {
    it('never returns the provider API key', async () => {
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-1', ...data }));
      const created = await service.create({
        name: 'X',
        provider: 'mock',
        externalModelId: 'x',
        apiKey: 'sk-secret',
      } as any);
      expect(created).not.toHaveProperty('apiKey');
      expect(created.hasApiKey).toBe(true);
    });

    it('auto-assigns default to the first active model', async () => {
      repository.exists.mockResolvedValue(false);
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-1', ...data }));
      const created = await service.create({ name: 'X', provider: 'mock', externalModelId: 'x' } as any);
      expect(created.isDefault).toBe(true);
    });

    it('does not steal the default flag when a default already exists', async () => {
      repository.exists.mockResolvedValue(true);
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-2', ...data }));
      const created = await service.create({ name: 'X', provider: 'mock', externalModelId: 'x' } as any);
      expect(created.isDefault).toBe(false);
    });
  });

  describe('default model invariant', () => {
    it('deactivating the default model is rejected', async () => {
      repository.findOne.mockResolvedValue(model({ isDefault: true }));
      await expect(service.update('model-1', { isActive: false })).rejects.toMatchObject({
        status: 400,
      });
    });

    it('deleting the default model is rejected', async () => {
      repository.findOne.mockResolvedValue(model({ isDefault: true }));
      await expect(service.remove('model-1')).rejects.toMatchObject({ status: 400 });
    });

    it('setting an inactive model as default is rejected', async () => {
      repository.findOne.mockResolvedValue(model({ isActive: false }));
      await expect(service.setDefault('model-1')).rejects.toMatchObject({ status: 400 });
    });

    it('setting a new default leaves exactly one default model', async () => {
      repository.findOne.mockResolvedValue(model({ id: 'model-B' }));
      const entityManagers: { update: jest.Mock }[] = [];
      repository.manager.transaction.mockImplementation(async (callback: any) => {
        const entityManager = { update: jest.fn(async () => undefined) };
        entityManagers.push(entityManager);
        return callback(entityManager);
      });

      await service.setDefault('model-B');

      const [clearCall, setCall] = entityManagers[0].update.mock.calls;
      // First clears ALL existing defaults, then sets the requested one.
      expect(clearCall).toEqual([expect.anything(), { isDefault: true }, { isDefault: false }]);
      expect(setCall).toEqual([expect.anything(), { id: 'model-B' }, { isDefault: true }]);
    });

    it('deactivating and deleting non-default models work', async () => {
      repository.findOne.mockResolvedValue(model({}));
      await expect(service.update('model-1', { isActive: false })).resolves.toMatchObject({
        isActive: false,
      });
      await expect(service.remove('model-1')).resolves.toBeUndefined();
    });
  });

  describe('resolveChatModel', () => {
    it('returns the requested active model', async () => {
      repository.findOne.mockResolvedValue(model({ id: 'model-A' }));
      await expect(service.resolveChatModel('model-A')).resolves.toMatchObject({ id: 'model-A' });
    });

    it('rejects an unknown requested model with 404', async () => {
      repository.findOne.mockResolvedValue(null);
      await expect(service.resolveChatModel('missing')).rejects.toMatchObject({ status: 404 });
    });

    it('rejects an inactive requested model with 400 (inactive models never chat)', async () => {
      repository.findOne.mockResolvedValue(model({ isActive: false }));
      await expect(service.resolveChatModel('model-A')).rejects.toMatchObject({ status: 400 });
    });

    it('falls back to the active default model', async () => {
      repository.findOne.mockResolvedValue(model({ isDefault: true }));
      const resolved = await service.resolveChatModel(undefined);
      expect(resolved.isDefault).toBe(true);
    });

    it('fails clearly when no default model exists', async () => {
      repository.findOne.mockResolvedValue(null);
      await expect(service.resolveChatModel(undefined)).rejects.toMatchObject({ status: 400 });
    });

    it('fails clearly when the default model is inactive', async () => {
      repository.findOne.mockResolvedValue(model({ isDefault: true, isActive: false }));
      await expect(service.resolveChatModel(undefined)).rejects.toMatchObject({ status: 400 });
    });

    it('rejects a premium (non-free) model requested by a free user with 403', async () => {
      repository.findOne.mockResolvedValue(model({ isFree: false }));
      await expect(service.resolveChatModel('model-1', 'free')).rejects.toMatchObject({
        status: 403,
      });
    });

    it('rejects usage after free access is revoked (re-checked on every send)', async () => {
      // Same model that used to be free; admin has since set isFree = false.
      repository.findOne.mockResolvedValue(model({ isFree: false }));
      await expect(service.resolveChatModel('model-1', 'free')).rejects.toMatchObject({
        status: 403,
      });
    });

    it('rejects an inactive premium model with 400 (inactive check first)', async () => {
      repository.findOne.mockResolvedValue(model({ isFree: false, isActive: false }));
      await expect(service.resolveChatModel('model-1', 'free')).rejects.toMatchObject({
        status: 400,
      });
    });

    it('fails clearly when the default model is not free', async () => {
      repository.findOne.mockResolvedValue(model({ isDefault: true, isFree: false }));
      await expect(service.resolveChatModel(undefined, 'free')).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe('listAvailable (plan-filtered)', () => {
    it('queries only active AND free models for the free plan', async () => {
      repository.find.mockResolvedValue([]);
      await service.listAvailable('free');
      expect(repository.find).toHaveBeenCalledWith({
        where: { isActive: true, isFree: true },
        order: { createdAt: 'ASC' },
      });
    });
  });

  describe('free-access admin rules', () => {
    it('removing free access from the default model is rejected', async () => {
      repository.findOne.mockResolvedValue(model({ isDefault: true }));
      await expect(service.update('model-1', { isFree: false })).rejects.toMatchObject({
        status: 400,
      });
    });

    it('setting a non-free model as default is rejected', async () => {
      repository.findOne.mockResolvedValue(model({ isFree: false }));
      await expect(service.setDefault('model-1')).rejects.toMatchObject({ status: 400 });
    });

    it('does not auto-default a non-free first model', async () => {
      repository.exists.mockResolvedValue(false);
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-1', ...data }));
      const created = await service.create({
        name: 'Premium',
        provider: 'mock',
        externalModelId: 'p-1',
        isFree: false,
      } as any);
      expect(created.isDefault).toBe(false);
    });

    it('free access can be removed from a non-default model', async () => {
      repository.findOne.mockResolvedValue(model({}));
      await expect(service.update('model-1', { isFree: false })).resolves.toMatchObject({
        isFree: false,
      });
    });

    it('free access can be granted to a premium model', async () => {
      repository.findOne.mockResolvedValue(model({ isFree: false }));
      await expect(service.update('model-1', { isFree: true })).resolves.toMatchObject({
        isFree: true,
      });
    });

    it('a deactivated model can be activated again', async () => {
      repository.findOne.mockResolvedValue(model({ isActive: false }));
      await expect(service.update('model-1', { isActive: true })).resolves.toMatchObject({
        isActive: true,
      });
    });
  });

  describe('capabilities', () => {
    it('normalizes capabilities on create (dedupe, closed set)', async () => {
      repository.exists.mockResolvedValue(true);
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-1', ...data }));
      const created = await service.create({
        name: 'X',
        provider: 'anthropic',
        externalModelId: 'claude-3-5-sonnet-latest',
        capabilities: ['web-search', 'reasoning', 'web-search'],
      } as any);
      expect(created.capabilities).toEqual(['web-search', 'reasoning']);
    });

    it('stores an empty list when no capabilities are declared', async () => {
      repository.exists.mockResolvedValue(true);
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-1', ...data }));
      const created = await service.create({
        name: 'X',
        provider: 'google',
        externalModelId: 'gemini-1.5-flash',
      } as any);
      expect(created.capabilities).toEqual([]);
    });

    it('drops unknown capability values at the service boundary (DTO is the first gate)', async () => {
      repository.exists.mockResolvedValue(true);
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-1', ...data }));
      const created = await service.create({
        name: 'X',
        provider: 'mock',
        externalModelId: 'x',
        capabilities: ['web-search', 'mystery-capability'],
      } as any);
      expect(created.capabilities).toEqual(['web-search']);
    });

    it('replaces capabilities on update', async () => {
      repository.findOne.mockResolvedValue(model({ capabilities: ['web-search'] }));
      await expect(
        service.update('model-1', { capabilities: ['reasoning'] } as any),
      ).resolves.toMatchObject({ capabilities: ['reasoning'] });
    });

    it('leaves capabilities untouched when the update omits them', async () => {
      repository.findOne.mockResolvedValue(model({ capabilities: ['reasoning'] }));
      await expect(
        service.update('model-1', { name: 'نام جدید' } as any),
      ).resolves.toMatchObject({ capabilities: ['reasoning'], name: 'نام جدید' });
    });

    it('accepts the new provider kinds in create and update', async () => {
      repository.exists.mockResolvedValue(true);
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-1', ...data }));
      const created = await service.create({
        name: 'Gemini',
        provider: 'google',
        externalModelId: 'gemini-1.5-flash',
      } as any);
      expect(created.provider).toBe('google');

      repository.findOne.mockResolvedValue(model({ provider: 'openai-compatible' }));
      await expect(
        service.update('model-1', { provider: 'anthropic' } as any),
      ).resolves.toMatchObject({ provider: 'anthropic' });
    });
  });

  describe('pricing serialization (INV-14)', () => {
    it('user-facing listAvailable strips pricing; admin listAll keeps it', async () => {
      repository.find.mockResolvedValue([
        model({
          inputPricePerMillion: '100.500000',
          outputPricePerMillion: '200.000000',
        }),
      ]);

      const [available] = await service.listAvailable('free');
      expect(available).not.toHaveProperty('inputPricePerMillion');
      expect(available).not.toHaveProperty('outputPricePerMillion');
      expect(available).toHaveProperty('hasApiKey');

      repository.find.mockClear();
      repository.find.mockResolvedValue([
        model({
          inputPricePerMillion: '100.500000',
          outputPricePerMillion: '200.000000',
        }),
      ]);
      const [admin] = await service.listAll();
      expect(admin).toMatchObject({
        inputPricePerMillion: '100.500000',
        outputPricePerMillion: '200.000000',
      });
      expect(admin).not.toHaveProperty('apiKey');
    });

    it('normalizes prices on create: empty or zero becomes null (not priced)', async () => {
      repository.exists.mockResolvedValue(true);
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-1', ...data }));
      const created = await service.create({
        name: 'X',
        provider: 'google',
        externalModelId: 'gemini-1.5-flash',
        inputPricePerMillion: '0',
        outputPricePerMillion: '  ',
      } as any);
      expect(created.inputPricePerMillion).toBeNull();
      expect(created.outputPricePerMillion).toBeNull();
    });

    it('accepts a positive price string on update', async () => {
      repository.findOne.mockResolvedValue(model({}));
      await expect(
        service.update('model-1', { inputPricePerMillion: '35000' } as any),
      ).resolves.toMatchObject({ inputPricePerMillion: '35000' });
    });
  });
});

describe('ModelsService — single-hop fallback configuration (day-7-8 contract §12)', () => {
  let service: ModelsService;
  let repository: ReturnType<typeof createMockRepository>;

  const model = (overrides: Partial<any> = {}) => ({
    id: 'model-1',
    name: 'Primary',
    provider: 'mock',
    externalModelId: 'mock-1',
    baseUrl: null,
    apiKey: null,
    isActive: true,
    isFree: true,
    isDefault: false,
    capabilities: [],
    fallbackModelId: null as string | null,
    ...overrides,
  });

  beforeEach(() => {
    repository = createMockRepository();
    service = new ModelsService(repository as any);
  });

  /**
   * update()/create() look up BOTH the model being edited and the fallback
   * candidate through findOne — the stub dispatches on the requested id so
   * each row gets its own fixture.
   */
  const stubFindOne = ({
    primary = {},
    fallback = null as Record<string, unknown> | null,
  } = {}) => {
    repository.findOne.mockImplementation(async (options: any) => {
      const id = options?.where?.id;
      if (id === 'model-1') return model(primary);
      if (id === 'model-2') return fallback === null ? model({ id: 'model-2' }) : model({ id: 'model-2', ...fallback });
      return null;
    });
  };

  describe('admin boundary rules', () => {
    it('accepts an existing active fallback that is at least as accessible', async () => {
      stubFindOne();
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-1', ...data }));

      await expect(
        service.update('model-1', { fallbackModelId: 'model-2' } as any),
      ).resolves.toMatchObject({ fallbackModelId: 'model-2', hasFallback: true });
    });

    it('rejects an unknown fallback model', async () => {
      stubFindOne();
      await expect(
        service.update('model-1', { fallbackModelId: 'missing-id' } as any),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects an inactive fallback model', async () => {
      stubFindOne({ fallback: { isActive: false } });
      await expect(
        service.update('model-1', { fallbackModelId: 'model-2' } as any),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects self-reference', async () => {
      stubFindOne();
      await expect(
        service.update('model-1', { fallbackModelId: 'model-1' } as any),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rejects a premium fallback for a free primary (free users must never 403 mid-turn)', async () => {
      stubFindOne({ fallback: { isFree: false } });
      await expect(
        service.update('model-1', { fallbackModelId: 'model-2' } as any),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('allows a free fallback for a premium primary', async () => {
      stubFindOne();
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-1', ...data }));

      await expect(
        service.update('model-1', { isFree: false, fallbackModelId: 'model-2' } as any),
      ).resolves.toMatchObject({ fallbackModelId: 'model-2' });
    });

    it('an explicit null clears the fallback without validation', async () => {
      repository.findOne.mockResolvedValue(model({ fallbackModelId: 'model-2' }));
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-1', ...data }));

      await expect(
        service.update('model-1', { fallbackModelId: null } as any),
      ).resolves.toMatchObject({ fallbackModelId: null, hasFallback: false });
    });

    it('validates the fallback against the EFFECTIVE accessibility on create', async () => {
      // dto declares isFree: false, so a premium fallback is acceptable even
      // though the default would be free.
      repository.findOne.mockResolvedValue(model({ id: 'model-2', isFree: false }));
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-9', ...data }));

      await expect(
        service.create({
          name: 'X',
          provider: 'mock',
          externalModelId: 'x',
          isFree: false,
          fallbackModelId: 'model-2',
        } as any),
      ).resolves.toMatchObject({ fallbackModelId: 'model-2' });
    });
  });

  describe('runtime resolveFallbackCandidate', () => {
    it('returns the candidate when active and plan-accessible', async () => {
      repository.findOne.mockResolvedValue(model({ id: 'model-2' }));
      await expect(
        service.resolveFallbackCandidate('model-2', 'free'),
      ).resolves.toMatchObject({ id: 'model-2' });
    });

    it('returns null for a missing or inactive candidate', async () => {
      repository.findOne.mockResolvedValue(null);
      await expect(service.resolveFallbackCandidate('x', 'free')).resolves.toBeNull();

      repository.findOne.mockResolvedValue(model({ id: 'model-2', isActive: false }));
      await expect(service.resolveFallbackCandidate('model-2', 'free')).resolves.toBeNull();
    });

    it('returns null when a free-plan caller would fall back into a premium model', async () => {
      repository.findOne.mockResolvedValue(model({ id: 'model-2', isFree: false }));
      await expect(service.resolveFallbackCandidate('model-2', 'free')).resolves.toBeNull();
      await expect(service.resolveFallbackCandidate('model-2', 'premium')).resolves.toMatchObject({
        id: 'model-2',
      });
    });

    it('honors the plan-scoped model allowlist', async () => {
      repository.findOne.mockResolvedValue(model({ id: 'model-2' }));
      await expect(
        service.resolveFallbackCandidate('model-2', 'premium', {
          allowedModelIds: ['model-1'],
          features: { thinking: true },
        }),
      ).resolves.toBeNull();
      await expect(
        service.resolveFallbackCandidate('model-2', 'premium', {
          allowedModelIds: ['model-1', 'model-2'],
          features: { thinking: true },
        }),
      ).resolves.toMatchObject({ id: 'model-2' });
    });

    it('refuses a reasoning-capable fallback when the plan lacks the thinking feature', async () => {
      repository.findOne.mockResolvedValue(model({ id: 'model-2', capabilities: ['reasoning'] }));
      await expect(
        service.resolveFallbackCandidate('model-2', 'premium', {
          allowedModelIds: null,
          features: { thinking: false },
        }),
      ).resolves.toBeNull();
    });

    it('exposes hasFallback on the safe serializer without leaking the row', async () => {
      repository.findOne.mockResolvedValue(model({}));
      repository.save.mockImplementation(async (data: any) => ({ id: 'model-1', ...data }));
      const updated = await service.update('model-1', { fallbackModelId: 'model-2' } as any);
      expect(updated.hasFallback).toBe(true);
      expect(updated).not.toHaveProperty('fallbackModel');
    });
  });
});
