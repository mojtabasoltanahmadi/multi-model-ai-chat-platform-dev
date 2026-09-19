import { UsageService } from './usage.service';

const model = (overrides: Partial<any> = {}) => ({
  id: 'model-1',
  inputPricePerMillion: null,
  outputPricePerMillion: null,
  ...overrides,
});

const turnStart = {
  userId: 'user-1',
  conversationId: 'conv-1',
  messageId: 'user-message-1',
  model: { id: 'model-1', provider: 'mock' as const, inputPricePerMillion: null, outputPricePerMillion: null },
  inputChars: 120,
};

describe('UsageService', () => {
  let repository: { findOne: jest.Mock; update: jest.Mock; manager: { findOne: jest.Mock } };
  let service: UsageService;

  beforeEach(() => {
    repository = {
      findOne: jest.fn().mockResolvedValue({ id: 'usage-1', modelId: 'model-1', inputChars: 120 }),
      update: jest.fn().mockResolvedValue(undefined),
      manager: { findOne: jest.fn().mockResolvedValue(model()) },
    };
    service = new UsageService(repository as any);
  });

  describe('recordTurnStart', () => {
    it('inserts a pending row anchored to the user message (unique dedupe anchor)', async () => {
      const insert = jest.fn().mockResolvedValue(undefined);
      await service.recordTurnStart({ insert } as any, turnStart);

      expect(insert).toHaveBeenCalledTimes(1);
      const [target, row] = insert.mock.calls[0];
      expect(target.name).toBe('UsageRecord');
      expect(row).toMatchObject({
        userId: 'user-1',
        conversationId: 'conv-1',
        messageId: 'user-message-1',
        modelId: 'model-1',
        provider: 'mock',
        inputChars: 120,
        outcome: 'pending',
      });
    });
  });

  describe('recordTurnEnd', () => {
    it('stores provider-reported tokens without the estimated flag', async () => {
      await service.recordTurnEnd('user-message-1', {
        outcome: 'completed',
        inputTokens: 100,
        outputTokens: 200,
        outputChars: 500,
      });

      expect(repository.update).toHaveBeenCalledWith(
        { messageId: 'user-message-1' },
        expect.objectContaining({
          inputTokens: 100,
          outputTokens: 200,
          outputChars: 500,
          outcome: 'completed',
          estimated: false,
          completedAt: expect.any(Date),
        }),
      );
    });

    it('estimates tokens as chars/4 (ceil) when the provider reports none', async () => {
      await service.recordTurnEnd('user-message-1', {
        outcome: 'completed',
        inputTokens: null,
        outputTokens: null,
        outputChars: 9,
      });

      expect(repository.update).toHaveBeenCalledWith(
        { messageId: 'user-message-1' },
        expect.objectContaining({
          inputTokens: Math.ceil(120 / 4),
          outputTokens: Math.ceil(9 / 4),
          estimated: true,
        }),
      );
    });

    it('computes cost from the model pricing (Toman per 1M tokens)', async () => {
      repository.manager.findOne.mockResolvedValue(
        model({ inputPricePerMillion: '1000000', outputPricePerMillion: '2000000' }),
      );

      await service.recordTurnEnd('user-message-1', {
        outcome: 'completed',
        inputTokens: 1000,
        outputTokens: 500,
        outputChars: 0,
      });

      // (1000/1M)×1M + (500/1M)×2M = 1000 + 1000 = 2000 Toman
      expect(repository.update).toHaveBeenCalledWith(
        { messageId: 'user-message-1' },
        expect.objectContaining({ cost: '2000.000000' }),
      );
    });

    it('leaves cost null for an unpriced model', async () => {
      await service.recordTurnEnd('user-message-1', {
        outcome: 'completed',
        inputTokens: 10,
        outputTokens: 10,
        outputChars: 0,
      });

      const update = repository.update.mock.calls[0][1];
      expect(update).not.toHaveProperty('cost');
    });

    it('leaves cost null when the model row is gone (SET NULL)', async () => {
      repository.findOne.mockResolvedValue({ id: 'usage-1', modelId: null, inputChars: 10 });

      await service.recordTurnEnd('user-message-1', {
        outcome: 'completed',
        inputTokens: 10,
        outputTokens: 10,
        outputChars: 0,
      });

      const update = repository.update.mock.calls[0][1];
      expect(update).not.toHaveProperty('cost');
    });

    it('never throws — accounting failures must not break the chat turn', async () => {
      repository.update.mockRejectedValue(new Error('db down'));
      await expect(
        service.recordTurnEnd('user-message-1', {
          outcome: 'failed',
          inputTokens: null,
          outputTokens: null,
          outputChars: 3,
        }),
      ).resolves.toBeUndefined();
    });

    it('skips silently when no usage row exists', async () => {
      repository.findOne.mockResolvedValue(null);
      await service.recordTurnEnd('missing', {
        outcome: 'completed',
        inputTokens: 1,
        outputTokens: 1,
        outputChars: 1,
      });
      expect(repository.update).not.toHaveBeenCalled();
    });
  });
});
