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
