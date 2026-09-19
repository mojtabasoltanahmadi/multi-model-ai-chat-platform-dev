import { WebhookService } from './webhook.service';
import { WebhookEvent } from './webhook-event.entity';
import { Payment } from './payment.entity';
import { Plan } from './plan.entity';
import { User } from '../users/user.entity';
import { Subscription } from './subscription.entity';
import { createMockRepository } from '../test/mocks';

/** Unique-violation shape thrown by Postgres on a lost insert race. */
const uniqueViolation = () => {
  const error = new Error('duplicate key value violates unique constraint');
  (error as { code?: string }).code = '23505';
  return error;
};

describe('WebhookService — idempotent processing pipeline', () => {
  let webhookEventsRepository: ReturnType<typeof createMockRepository>;
  let paymentsRepository: ReturnType<typeof createMockRepository>;
  let plansRepository: ReturnType<typeof createMockRepository>;
  let usersRepository: ReturnType<typeof createMockRepository>;
  let subscriptionsRepository: ReturnType<typeof createMockRepository>;
  let paymentsService: { transitionInTransaction: jest.Mock };
  let subscriptionsService: { activateInTransaction: jest.Mock };
  let auditService: { record: jest.Mock };
  let service: WebhookService;
  let manager: Record<string, unknown>;
  /** Rows inserted into the inbox during the current transaction. */
  let inbox: WebhookEvent[];

  const plan: Plan = {
    id: 'plan-1',
    slug: 'pro',
    name: 'Pro',
    description: null,
    price: '200000',
    currency: 'IRT',
    billingPeriod: 'monthly',
    dailyMessageQuota: 500,
    dailyTokenQuota: null,
    allowedModelIds: null,
    webSearch: true,
    thinking: true,
    fileProcessing: true,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Plan;

  const pendingPayment: Payment = {
    id: 'pay-1',
    userId: 'user-1',
    planId: 'plan-1',
    amount: '200000',
    currency: 'IRT',
    status: 'pending',
    planSnapshot: {
      planId: 'plan-1',
      planSlug: 'pro',
      planName: 'Pro',
      price: '200000',
      currency: 'IRT',
      billingPeriod: 'monthly',
    },
    trackingId: 'trk_1',
    scenario: null,
    failureReason: null,
    succeededAt: null,
    createdAt: new Date(),
  } as Payment;

  const setup = () => {
    inbox = [];
    webhookEventsRepository = createMockRepository();
    paymentsRepository = createMockRepository();
    plansRepository = createMockRepository();
    usersRepository = createMockRepository();
    subscriptionsRepository = createMockRepository();

    // The webhook inbox save is the idempotency anchor. A save WITHOUT an id
    // is the initial INSERT (unique provider+eventId applies); a save WITH an
    // id is the finish() status update of an already-stored row.
    const eventRepo = webhookEventsRepository as any;
    eventRepo.save = jest.fn(async (row: WebhookEvent) => {
      if (!row.id) {
        if (inbox.some((existing) => existing.eventId === row.eventId)) {
          throw uniqueViolation();
        }
        row.id = `wh-${inbox.length + 1}`;
        inbox.push(row);
      } else {
        const index = inbox.findIndex((existing) => existing.id === row.id);
        if (index >= 0) inbox[index] = row;
      }
      return row;
    });
    eventRepo.findOne = jest.fn(async ({ where }: { where: { eventId: string } }) =>
      inbox.find((row) => row.eventId === where.eventId) ?? null,
    );

    paymentsRepository.findOne = jest.fn(async () => ({ ...pendingPayment }));
    plansRepository.findOne = jest.fn(async () => ({ ...plan }));
    usersRepository.update = jest.fn(async () => undefined);

    // Transactional manager: every getRepository() returns the domain repo,
    // and transaction() simply runs the callback against itself.
    manager = {
      getRepository: (entity: unknown) =>
        ({
          [WebhookEvent.name]: eventRepo,
          [Payment.name]: paymentsRepository,
          [Plan.name]: plansRepository,
          [User.name]: usersRepository,
          [Subscription.name]: subscriptionsRepository,
        } as Record<string, unknown>)[(entity as { name: string }).name],
    };
    manager.transaction = async (callback: (m: unknown) => unknown) => callback(manager);
    webhookEventsRepository.manager = manager as never;

    paymentsService = {
      transitionInTransaction: jest.fn(async (_m: unknown, id: string, next: string) => ({
        ...pendingPayment,
        id,
        status: next,
      })),
    };
    subscriptionsService = { activateInTransaction: jest.fn(async () => ({})) };
    auditService = { record: jest.fn().mockResolvedValue(undefined) };

    service = new WebhookService(
      eventRepo as never,
      paymentsService as never,
      subscriptionsService as never,
      auditService as never,
    );
  };

  const event = (overrides: Record<string, unknown> = {}) => ({
    eventId: 'evt-1',
    eventType: 'payment.succeeded',
    payload: { paymentId: 'pay-1' },
    ...overrides,
  });

  beforeEach(setup);

  // ---- INV-02 / INV-04: one business effect per gateway event ----

  it('processes a success event: transition + activation + premium flag, atomically in one transaction', async () => {
    const result = await service.processEvent(event());

    expect(result).toEqual({ status: 'processed' });
    expect(paymentsService.transitionInTransaction).toHaveBeenCalledWith(
      manager,
      'pay-1',
      'success',
      { scenario: 'webhook' },
    );
    expect(subscriptionsService.activateInTransaction).toHaveBeenCalledWith(
      manager,
      'user-1',
      plan,
      'pay-1',
    );
    // Payment→subscription(+user plan sync)→audit all inside the SAME
    // transaction (INV-03).
    expect(inbox).toHaveLength(1);
    expect(inbox[0].status).toBe('processed');
  });

  it('a duplicate delivery of the SAME event id produces NO second business effect', async () => {
    await service.processEvent(event());
    paymentsService.transitionInTransaction.mockClear();
    subscriptionsService.activateInTransaction.mockClear();
    usersRepository.update.mockClear();

    const result = await service.processEvent(event());

    expect(result).toEqual({ status: 'duplicate' });
    expect(paymentsService.transitionInTransaction).not.toHaveBeenCalled();
    expect(subscriptionsService.activateInTransaction).not.toHaveBeenCalled();
    expect(usersRepository.update).not.toHaveBeenCalled();
    // The audit trail distinguishes duplicates from first deliveries.
    expect(auditService.record).toHaveBeenCalledWith(
      'webhook.duplicate',
      expect.objectContaining({ correlationId: 'evt-1' }),
    );
  });

  it('models the concurrent race: the loser of the insert gets duplicate, not an error', async () => {
    // Simulates request B racing request A: the inbox insert hits the
    // unique (provider, eventId) constraint exactly like two simultaneous
    // HTTP deliveries would in Postgres.
    const first = await service.processEvent(event());
    const racing = await service.processEvent(event());
    expect(first.status).toBe('processed');
    expect(racing.status).toBe('duplicate');
  });

  it('a gateway RETRY with a fresh event id on an already-succeeded payment is ignored (no double activation)', async () => {
    await service.processEvent(event());
    subscriptionsService.activateInTransaction.mockClear();
    usersRepository.update.mockClear();
    paymentsRepository.findOne = jest.fn(async () => ({ ...pendingPayment, status: 'success' }));

    const result = await service.processEvent(event({ eventId: 'evt-retry' }));

    expect(result).toEqual({ status: 'ignored', reason: 'payment-already-success' });
    expect(subscriptionsService.activateInTransaction).not.toHaveBeenCalled();
    expect(usersRepository.update).not.toHaveBeenCalled();
  });

  // ---- Out-of-order safety ----

  it('an out-of-order success after cancellation is ignored — never resurrected', async () => {
    paymentsRepository.findOne = jest.fn(async () => ({ ...pendingPayment, status: 'cancelled' }));

    const result = await service.processEvent(event());

    expect(result).toEqual({ status: 'ignored', reason: 'payment-already-cancelled' });
    expect(paymentsService.transitionInTransaction).not.toHaveBeenCalled();
  });

  // ---- Failed / cancelled outcomes ----

  it('a failure event transitions the payment to failed with the gateway reason', async () => {
    const result = await service.processEvent(
      event({ eventType: 'payment.failed', payload: { paymentId: 'pay-1', failureReason: 'declined' } }),
    );

    expect(result.status).toBe('processed');
    expect(paymentsService.transitionInTransaction).toHaveBeenCalledWith(
      manager,
      'pay-1',
      'failed',
      { failureReason: 'declined', scenario: 'webhook' },
    );
    expect(subscriptionsService.activateInTransaction).not.toHaveBeenCalled();
  });

  it('a cancelled event transitions the payment to cancelled without touching subscriptions', async () => {
    const result = await service.processEvent(
      event({ eventType: 'payment.cancelled', payload: { paymentId: 'pay-1' } }),
    );

    expect(result.status).toBe('processed');
    expect(paymentsService.transitionInTransaction).toHaveBeenCalledWith(
      manager,
      'pay-1',
      'cancelled',
      { scenario: 'webhook' },
    );
  });

  // ---- Unknown / invalid events ----

  it('an unknown event type is acknowledged as ignored, never applied', async () => {
    const result = await service.processEvent(
      event({ eventType: 'payout.reversed', payload: { paymentId: 'pay-1' } }),
    );

    expect(result).toEqual({ status: 'ignored', reason: 'unknown-event-type' });
    expect(paymentsService.transitionInTransaction).not.toHaveBeenCalled();
  });

  it('an event without a payment reference is ignored (missing-payment-reference)', async () => {
    const result = await service.processEvent(event({ payload: {} }));

    expect(result).toEqual({ status: 'ignored', reason: 'missing-payment-reference' });
  });

  it('an event referencing an unknown payment is ignored, not crashed', async () => {
    paymentsRepository.findOne = jest.fn(async () => null);

    const result = await service.processEvent(event());

    expect(result).toEqual({ status: 'ignored', reason: 'payment-not-found' });
  });

  it('a missing plan row rolls the transaction back (throws) so the gateway retries', async () => {
    plansRepository.findOne = jest.fn(async () => null);

    await expect(service.processEvent(event())).rejects.toThrow(/Plan row missing/);
  });
});
