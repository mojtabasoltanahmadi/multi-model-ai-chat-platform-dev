import { ConflictException } from '@nestjs/common';
import {
  assertPaymentTransition,
  PaymentsService,
} from './payments.service';
import { Payment, PlanSnapshot } from './payment.entity';
import { Plan } from './plan.entity';
import { createMockRepository } from '../test/mocks';

const snapshot: PlanSnapshot = {
  planId: 'plan-1',
  planSlug: 'pro',
  planName: 'Pro',
  price: '200000',
  currency: 'IRT',
  billingPeriod: 'monthly',
};

const activePlan: Plan = {
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

const pendingPayment = (overrides: Partial<Payment> = {}): Payment =>
  ({
    id: 'pay-1',
    userId: 'user-1',
    planId: 'plan-1',
    amount: '200000',
    currency: 'IRT',
    status: 'pending',
    planSnapshot: snapshot,
    trackingId: 'trk_1',
    scenario: null,
    failureReason: null,
    succeededAt: null,
    createdAt: new Date(),
    ...overrides,
  }) as Payment;

describe('assertPaymentTransition — explicit state machine', () => {
  it('allows pending → success / failed / cancelled', () => {
    expect(() => assertPaymentTransition('pending', 'success')).not.toThrow();
    expect(() => assertPaymentTransition('pending', 'failed')).not.toThrow();
    expect(() => assertPaymentTransition('pending', 'cancelled')).not.toThrow();
  });

  it('rejects SUCCESS → PENDING and every mutation out of a terminal state', () => {
    expect(() => assertPaymentTransition('success', 'pending')).toThrow(/Invalid payment transition/);
    expect(() => assertPaymentTransition('success', 'failed')).toThrow();
    expect(() => assertPaymentTransition('failed', 'success')).toThrow();
    expect(() => assertPaymentTransition('cancelled', 'success')).toThrow();
  });
});

describe('PaymentsService', () => {
  let paymentsRepository: ReturnType<typeof createMockRepository>;
  let plansRepository: ReturnType<typeof createMockRepository>;
  let auditService: { record: jest.Mock };
  let service: PaymentsService;

  beforeEach(() => {
    paymentsRepository = createMockRepository();
    plansRepository = createMockRepository();
    plansRepository.findOne = jest.fn(async () => ({ ...activePlan }));
    auditService = { record: jest.fn().mockResolvedValue(undefined) };
    service = new PaymentsService(
      paymentsRepository as never,
      plansRepository as never,
      auditService as never,
    );
  });

  // ---- Server-authoritative price (client price manipulation) ----

  it('resolves the amount from the PLAN row — client input never touches money', async () => {
    paymentsRepository.save = jest.fn(async (data: Payment) => ({ ...data, id: 'pay-new' }));

    const payment = await service.create('user-1', 'plan-1', 'a@b.c');

    // The DTO only ever carries planId; amount/currency come from the row.
    expect(payment.amount).toBe('200000');
    expect(payment.currency).toBe('IRT');
    expect(payment.planSnapshot.price).toBe('200000');
    expect(payment.trackingId).toMatch(/^trk_/);
    expect(auditService.record).toHaveBeenCalledWith('payment.created', expect.anything());
  });

  it('refuses payments for unknown or deactivated plans', async () => {
    plansRepository.findOne = jest.fn(async () => null);
    await expect(service.create('user-1', 'plan-x', null)).rejects.toMatchObject({ status: 404 });

    plansRepository.findOne = jest.fn(async () => ({ ...activePlan, isActive: false }));
    await expect(service.create('user-1', 'plan-1', null)).rejects.toBeInstanceOf(ConflictException);
  });

  // ---- Double-click / duplicate submit ----

  it('a second PENDING payment for the same (user, plan) returns the existing one', async () => {
    const existing = pendingPayment();
    paymentsRepository.findOne = jest.fn(async () => existing);
    paymentsRepository.save = jest.fn(async () => {
      throw new Error('must not create a second payment');
    });

    const payment = await service.create('user-1', 'plan-1', null);

    expect(payment.id).toBe('pay-1');
    expect(paymentsRepository.save).not.toHaveBeenCalled();
  });

  // ---- IDOR ----

  it('another user’s payment is indistinguishable from a missing one (404, no data leak)', async () => {
    paymentsRepository.findOne = jest.fn(async () => pendingPayment({ userId: 'user-2' }));

    await expect(service.getOwned('user-1', 'pay-1')).rejects.toMatchObject({ status: 404 });
    await expect(service.getOwned('user-1', 'missing')).rejects.toMatchObject({ status: 404 });
  });

  // ---- User cancellation ----

  it('the owner can cancel a PENDING payment only', async () => {
    paymentsRepository.findOne = jest.fn(async () => pendingPayment());
    const saved = await service.cancelPending('user-1', 'pay-1', 'a@b.c');
    expect(saved.status).toBe('cancelled');

    paymentsRepository.findOne = jest.fn(async () => pendingPayment({ status: 'success' }));
    await expect(service.cancelPending('user-1', 'pay-1', 'a@b.c')).rejects.toThrow(
      /Invalid payment transition/,
    );
  });
});
