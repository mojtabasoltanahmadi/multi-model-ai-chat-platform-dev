import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Payment, PaymentStatus, PlanSnapshot } from './payment.entity';
import { Plan } from './plan.entity';
import { AuditEventType, AuditService } from './audit.service';
import { randomUUID } from 'crypto';

/**
 * Explicit payment state machine (INV: no arbitrary mutation). Anything not
 * listed must never happen through application flows. Exported for tests.
 */
export function assertPaymentTransition(current: PaymentStatus, next: PaymentStatus): void {
  const allowed: Record<PaymentStatus, PaymentStatus[]> = {
    pending: ['success', 'failed', 'cancelled'],
    success: [],
    failed: [],
    cancelled: [],
  };
  if (!allowed[current]?.includes(next)) {
    throw new Error(`Invalid payment transition: ${current} → ${next}`);
  }
}

/** Shape returned to users — never leaks internal failure details. */
export type UserPayment = Pick<
  Payment,
  'id' | 'planId' | 'amount' | 'currency' | 'status' | 'trackingId' | 'failureReason' | 'createdAt' | 'succeededAt'
> & { plan: { slug: string; name: string; billingPeriod: string } };

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly paymentsRepository: Repository<Payment>,
    @InjectRepository(Plan)
    private readonly plansRepository: Repository<Plan>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Creates a PENDING payment. The amount is resolved from the Plan row
   * server-side — client-sent prices do not exist anywhere in the flow
   * (anti "client-side price manipulation").
   *
   * Double-click / duplicate submit: the (user, plan) PENDING partial unique
   * index makes a second pending payment impossible; the service check turns
   * that race into an idempotent "return the existing pending payment".
   */
  async create(userId: string, planId: string, actor: string | null): Promise<Payment> {
    const plan = await this.plansRepository.findOne({ where: { id: planId } });
    if (!plan) {
      throw new NotFoundException('طرح مورد نظر پیدا نشد.');
    }
    if (!plan.isActive) {
      throw new ConflictException('این طرح در حال حاضر قابل خریداری نیست.');
    }

    const existing = await this.paymentsRepository.findOne({
      where: { userId, planId, status: 'pending' },
    });
    if (existing) {
      this.logger.log(`PaymentDeduped userId=${userId} paymentId=${existing.id}`);
      return existing;
    }

    const snapshot: PlanSnapshot = {
      planId: plan.id,
      planSlug: plan.slug,
      planName: plan.name,
      price: plan.price,
      currency: plan.currency,
      billingPeriod: plan.billingPeriod,
    };
    const payment = await this.paymentsRepository.save({
      userId,
      planId: plan.id,
      amount: plan.price,
      currency: plan.currency,
      status: 'pending' as PaymentStatus,
      planSnapshot: snapshot,
      trackingId: `trk_${randomUUID()}`,
    });
    await this.auditService.record(AuditEventType.PAYMENT_CREATED, {
      actorId: userId,
      actor,
      target: `payment:${payment.id}`,
      correlationId: payment.trackingId,
      metadata: { userId, planSlug: plan.slug, amount: plan.price, currency: plan.currency },
    });
    return payment;
  }

  /** IDOR-safe owned fetch: another user's payment is indistinguishable from a missing one. */
  async getOwned(userId: string, paymentId: string): Promise<Payment> {
    const payment = await this.paymentsRepository.findOne({ where: { id: paymentId } });
    if (!payment || payment.userId !== userId) {
      throw new NotFoundException('پرداخت مورد نظر پیدا نشد.');
    }
    return payment;
  }

  async listForUser(userId: string): Promise<Payment[]> {
    return this.paymentsRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  /** User aborts the checkout of a pending payment. */
  async cancelPending(userId: string, paymentId: string, actor: string | null): Promise<Payment> {
    const payment = await this.getOwned(userId, paymentId);
    assertPaymentTransition(payment.status, 'cancelled');
    payment.status = 'cancelled';
    payment.scenario = 'user-cancelled';
    const saved = await this.paymentsRepository.save(payment);
    await this.auditService.record(AuditEventType.PAYMENT_CANCELLED, {
      actorId: userId,
      actor,
      target: `payment:${payment.id}`,
      correlationId: payment.trackingId,
      metadata: { userId, reason: 'user-cancelled' },
    });
    return saved;
  }

  /**
   * State-mutating transition used by the webhook pipeline. MUST run inside
   * the caller's transaction; the row is locked FOR UPDATE so concurrent
   * events serialize and exactly one wins (INV-02/INV-04).
   */
  async transitionInTransaction(
    manager: EntityManager,
    paymentId: string,
    next: PaymentStatus,
    extra: { failureReason?: string; scenario?: string } = {},
  ): Promise<Payment | null> {
    const repo = manager.getRepository(Payment);
    const payment = await repo.findOne({
      where: { id: paymentId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payment) return null;
    assertPaymentTransition(payment.status, next);
    payment.status = next;
    if (extra.failureReason) payment.failureReason = extra.failureReason;
    if (extra.scenario) payment.scenario = extra.scenario;
    if (next === 'success') payment.succeededAt = new Date();
    return repo.save(payment);
  }

  /** Admin listing with optional filters. */
  async listAll(filters: { userId?: string; status?: string; limit?: number } = {}): Promise<Payment[]> {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const qb = this.paymentsRepository
      .createQueryBuilder('payment')
      .orderBy('payment.createdAt', 'DESC')
      .take(limit);
    if (filters.userId) qb.andWhere('payment.userId = :userId', { userId: filters.userId });
    if (filters.status) qb.andWhere('payment.status = :status', { status: filters.status });
    return qb.getMany();
  }

  toUserPayment(payment: Payment): UserPayment {
    return {
      id: payment.id,
      planId: payment.planId,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      trackingId: payment.trackingId,
      failureReason: payment.failureReason,
      createdAt: payment.createdAt,
      succeededAt: payment.succeededAt,
      plan: {
        slug: payment.planSnapshot.planSlug,
        name: payment.planSnapshot.planName,
        billingPeriod: payment.planSnapshot.billingPeriod,
      },
    };
  }
}
