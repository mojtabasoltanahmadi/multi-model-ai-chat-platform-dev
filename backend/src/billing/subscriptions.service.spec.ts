import {
  assertSubscriptionTransition,
  SubscriptionsService,
} from './subscriptions.service';
import { Subscription } from './subscription.entity';
import { Plan } from './plan.entity';
import { createMockRepository } from '../test/mocks';

const planRow = (overrides: Partial<Plan> = {}): Plan =>
  ({
    id: 'plan-1',
    slug: 'pro',
    name: 'Pro',
    billingPeriod: 'monthly',
    price: '200000',
    currency: 'IRT',
    dailyMessageQuota: 500,
    dailyTokenQuota: null,
    allowedModelIds: null,
    webSearch: true,
    thinking: true,
    fileProcessing: true,
    isActive: true,
    description: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Plan;

const subscriptionRow = (overrides: Partial<Subscription> = {}): Subscription =>
  ({
    id: 'sub-old',
    userId: 'user-1',
    planId: 'plan-1',
    planSlug: 'pro',
    planName: 'Pro',
    status: 'active',
    currentPeriodStart: new Date(Date.now() - 40 * 24 * 3600 * 1000),
    currentPeriodEnd: new Date(Date.now() - 10 * 24 * 3600 * 1000),
    sourcePaymentId: 'pay-0',
    cancelledAt: null,
    createdAt: new Date(),
    ...overrides,
  }) as Subscription;

describe('assertSubscriptionTransition — explicit lifecycle', () => {
  it('allows pending→active, active→expired/cancelled and rejects the rest', () => {
    expect(() => assertSubscriptionTransition('pending', 'active')).not.toThrow();
    expect(() => assertSubscriptionTransition('active', 'expired')).not.toThrow();
    expect(() => assertSubscriptionTransition('active', 'cancelled')).not.toThrow();
    expect(() => assertSubscriptionTransition('expired', 'active')).toThrow(/Invalid subscription transition/);
    expect(() => assertSubscriptionTransition('cancelled', 'active')).toThrow();
    expect(() => assertSubscriptionTransition('pending', 'expired')).toThrow();
  });
});

describe('SubscriptionsService', () => {
  let subscriptionsRepository: ReturnType<typeof createMockRepository>;
  let auditService: { record: jest.Mock };
  let service: SubscriptionsService;
  let txRepo: ReturnType<typeof createMockRepository>;
  let manager: { getRepository: jest.Mock; transaction: jest.Mock };

  beforeEach(() => {
    subscriptionsRepository = createMockRepository();
    auditService = { record: jest.fn().mockResolvedValue(undefined) };
    txRepo = createMockRepository();
    manager = {
      getRepository: jest.fn(() => txRepo),
      transaction: jest.fn(async (cb: (m: unknown) => unknown) => cb(manager)),
    };
    subscriptionsRepository.manager = manager as never;
    service = new SubscriptionsService(
      subscriptionsRepository as never,
      auditService as never,
    );
  });

  // ---- INV-01 / INV-03: one active subscription, activated atomically ----

  it('activation closes any previous active subscription before creating the new one', async () => {
    const previous = subscriptionRow({ id: 'sub-prev', currentPeriodEnd: new Date(Date.now() + 24 * 3600 * 1000) });
    txRepo.find = jest.fn(async () => [previous]);
    txRepo.create = jest.fn((data: Partial<Subscription>) => ({ id: 'sub-new', ...data }));
    txRepo.save = jest.fn(async (row: Subscription) => row);

    await service.activateInTransaction(manager as never, 'user-1', planRow(), 'pay-1');

    expect(previous.status).toBe('cancelled');
    expect(txRepo.save).toHaveBeenCalledWith(previous);
    const created = txRepo.create.mock.calls[0][0];
    expect(created.status).toBe('active');
    expect(created.sourcePaymentId).toBe('pay-1');
    // 30-day monthly period, deterministic.
    const days = (created.currentPeriodEnd.getTime() - created.currentPeriodStart.getTime()) / 86400000;
    expect(Math.round(days)).toBe(30);
  });

  it('activation emits subscription.activated + access.granted INSIDE the transaction', async () => {
    txRepo.find = jest.fn(async () => []);
    txRepo.create = jest.fn((data: Partial<Subscription>) => ({ id: 'sub-new', ...data }));
    txRepo.save = jest.fn(async (row: Subscription) => row);

    await service.activateInTransaction(manager as never, 'user-1', planRow(), 'pay-1', 'a@b.c');

    const eventTypes = auditService.record.mock.calls.map((call) => call[0]);
    expect(eventTypes).toEqual(expect.arrayContaining(['subscription.activated', 'access.granted']));
    // Every audit call carried the manager → atomic with the activation.
    auditService.record.mock.calls.forEach((call) => expect(call[2]).toBe(manager));
    // The denormalized users.plan flag flips to premium in the same transaction.
    expect(txRepo.update).toHaveBeenCalledWith({ id: 'user-1' }, { plan: 'premium' });
  });

  // ---- INV-06: lazy expiration ----

  it('an overdue ACTIVE subscription is expired exactly once, with audits', async () => {
    const overdue = subscriptionRow();
    txRepo.findOne = jest.fn(async () => overdue);
    txRepo.save = jest.fn(async (row: Subscription) => row);

    const expired = await service.expireIfDue('sub-old');

    expect(expired).toBe(true);
    expect(overdue.status).toBe('expired');
    const eventTypes = auditService.record.mock.calls.map((call) => call[0]);
    expect(eventTypes).toEqual(expect.arrayContaining(['subscription.expired', 'access.revoked']));
    // users.plan flag synced back to free in the same transaction.
    expect(txRepo.update).toHaveBeenCalledWith({ id: 'user-1' }, { plan: 'free' });
  });

  it('a future-period subscription is NOT expired (idempotent re-check under lock)', async () => {
    const fresh = subscriptionRow({ currentPeriodEnd: new Date(Date.now() + 24 * 3600 * 1000) });
    txRepo.findOne = jest.fn(async () => fresh);

    expect(await service.expireIfDue('sub-old')).toBe(false);
    expect(fresh.status).toBe('active');
  });

  it('getActiveOrExpire drops overdue rows and returns the newest live one', async () => {
    const overdue = subscriptionRow({ id: 'sub-overdue' });
    const live = subscriptionRow({
      id: 'sub-live',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 24 * 3600 * 1000),
      createdAt: new Date(),
    });
    txRepo.findOne = jest.fn(async () => overdue);
    txRepo.save = jest.fn(async (row: Subscription) => row);
    subscriptionsRepository.find = jest.fn(async () => [live, overdue]);

    const current = await service.getActiveOrExpire('user-1');

    expect(current?.id).toBe('sub-live');
    expect(overdue.status).toBe('expired');
  });

  // ---- Cancellation ----

  it('user cancellation marks the row cancelled and revokes access via audit', async () => {
    const live = subscriptionRow({ currentPeriodEnd: new Date(Date.now() + 24 * 3600 * 1000) });
    subscriptionsRepository.findOne = jest.fn(async () => live);
    subscriptionsRepository.save = jest.fn(async (row: Subscription) => row);

    await service.cancel('sub-old', 'user-1', 'a@b.c');

    expect(live.status).toBe('cancelled');
    expect(live.cancelledAt).toBeInstanceOf(Date);
    const eventTypes = auditService.record.mock.calls.map((call) => call[0]);
    expect(eventTypes).toEqual(expect.arrayContaining(['subscription.cancelled', 'access.revoked']));
    expect(txRepo.update).toHaveBeenCalledWith({ id: 'user-1' }, { plan: 'free' });
  });

  it('cancelling an already-expired subscription is rejected by the state machine', async () => {
    subscriptionsRepository.findOne = jest.fn(async () => subscriptionRow({ status: 'expired' }));

    await expect(service.cancel('sub-old', 'user-1', null)).rejects.toThrow(
      /Invalid subscription transition/,
    );
  });
});
