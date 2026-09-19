import { AuditService } from './audit.service';
import { createMockRepository } from '../test/mocks';

describe('AuditService — append-only trail (INV-08)', () => {
  let auditRepository: ReturnType<typeof createMockRepository>;
  let service: AuditService;

  beforeEach(() => {
    auditRepository = createMockRepository();
    service = new AuditService(auditRepository as never);
  });

  it('records an event with actor/target/correlation/metadata — best-effort, never throws', async () => {
    await expect(
      service.record('payment.created', {
        actorId: 'user-1',
        actor: 'a@b.c',
        target: 'payment:pay-1',
        correlationId: 'trk_1',
        metadata: { amount: '200000' },
      }),
    ).resolves.toBeUndefined();

    const [logged] = auditRepository.saved;
    expect(logged.eventType).toBe('payment.created');
    expect(logged.target).toBe('payment:pay-1');
    expect(logged.metadata).toEqual({ amount: '200000' });
  });

  it('an audit write failure outside a transaction is swallowed and logged, not raised', async () => {
    auditRepository.save = jest.fn(async () => {
      throw new Error('db down');
    });

    await expect(service.record('payment.created', {})).resolves.toBeUndefined();
  });

  it('an audit write failure INSIDE a transaction propagates (atomicity wins)', async () => {
    const failingManager = { save: jest.fn(async () => { throw new Error('db down'); }) };

    await expect(service.record('payment.created', {}, failingManager as never)).rejects.toThrow(
      'db down',
    );
  });

  it('the admin listing is read-only (query builder) with filters', async () => {
    const chain: Record<string, jest.Mock> = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn(async () => []),
    };
    (auditRepository as any).createQueryBuilder = jest.fn(() => chain);

    await service.list({ eventType: 'payment.created', userId: 'user-1', limit: 25 });

    expect(chain.take).toHaveBeenCalledWith(25);
    expect(chain.andWhere).toHaveBeenCalledTimes(2);
  });
});
