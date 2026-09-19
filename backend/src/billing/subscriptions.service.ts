import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Subscription, SubscriptionStatus } from './subscription.entity';
import { BILLING_PERIOD_DAYS, Plan } from './plan.entity';
import { AuditEventType, AuditService } from './audit.service';
import { User } from '../users/user.entity';

/**
 * Explicit lifecycle transitions. A renewal/upgrade NEVER mutates an expired
 * or cancelled row — it creates a new subscription. Exported for tests.
 */
export function assertSubscriptionTransition(
  current: SubscriptionStatus,
  next: SubscriptionStatus,
): void {
  const allowed: Record<SubscriptionStatus, SubscriptionStatus[]> = {
    pending: ['active', 'cancelled'],
    active: ['expired', 'cancelled'],
    expired: [],
    cancelled: [],
  };
  if (!allowed[current]?.includes(next)) {
    throw new Error(`Invalid subscription transition: ${current} → ${next}`);
  }
}

/**
 * Owns every subscription status mutation:
 *  - activation (inside the payment transaction — INV-03),
 *  - lazy expiration (INV-06: checked on entitlement read; no cron needed),
 *  - user-requested cancellation.
 * Each mutation emits audit events and keeps users.plan in sync so the
 * existing model-access + quota + UI layers keep working unchanged.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    @InjectRepository(Subscription)
    private readonly subscriptionsRepository: Repository<Subscription>,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Closes any conflicting active subscription and creates the new ACTIVE row
   * for the just-paid plan. MUST run inside the webhook/payment transaction
   * (manager) so payment + subscription + audit commit or roll back together
   * (INV-03). Plan deactivation does NOT block activation of an already-paid
   * plan (documented policy: deactivation stops new purchases only).
   */
  async activateInTransaction(
    manager: EntityManager,
    userId: string,
    plan: Plan,
    paymentId: string,
    actor: string | null = null,
  ): Promise<Subscription> {
    const now = new Date();
    const repo = manager.getRepository(Subscription);

    const previous = await repo.find({ where: { userId, status: 'active' } });
    for (const old of previous) {
      assertSubscriptionTransition(old.status, 'cancelled');
      old.status = 'cancelled';
      old.cancelledAt = now;
      await repo.save(old);
      await this.auditService.record(
        AuditEventType.SUBSCRIPTION_CANCELLED,
        {
          actorId: userId,
          actor,
          target: `subscription:${old.id}`,
          correlationId: paymentId,
          metadata: { userId, reason: 'superseded-by-new-payment', newPlanSlug: plan.slug },
        },
        manager,
      );
    }

    const periodDays = BILLING_PERIOD_DAYS[plan.billingPeriod] ?? 30;
    const periodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);

    const subscription = repo.create({
      userId,
      planId: plan.id,
      planSlug: plan.slug,
      planName: plan.name,
      status: 'active' as SubscriptionStatus,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      sourcePaymentId: paymentId,
    });
    const saved = await repo.save(subscription);

    await this.auditService.record(
      AuditEventType.SUBSCRIPTION_ACTIVATED,
      {
        actorId: userId,
        actor,
        target: `subscription:${saved.id}`,
        correlationId: paymentId,
        metadata: { userId, planSlug: plan.slug, currentPeriodEnd: periodEnd.toISOString() },
      },
      manager,
    );
    await this.auditService.record(
      AuditEventType.ACCESS_GRANTED,
      {
        actorId: userId,
        actor,
        target: `user:${userId}`,
        correlationId: paymentId,
        metadata: { planSlug: plan.slug, via: 'payment' },
      },
      manager,
    );
    await this.syncUserPlan(userId, 'premium', manager);
    this.logger.log(
      `SubscriptionActivated userId=${userId} planSlug=${plan.slug} subscriptionId=${saved.id}`,
    );
    return saved;
  }

  /**
   * Keeps the denormalized users.plan flag ('free' | 'premium') aligned with
   * the subscription state. Access control NEVER reads this flag — the
   * EntitlementsService resolves from subscriptions/plans directly — it only
   * feeds the existing admin views and the sidebar plan badge.
   */
  private async syncUserPlan(
    userId: string,
    plan: 'free' | 'premium',
    manager?: EntityManager,
  ): Promise<void> {
    const repo = manager
      ? manager.getRepository(User)
      : this.subscriptionsRepository.manager.getRepository(User);
    await repo.update({ id: userId }, { plan });
  }

  /**
   * Lazy expiration for ONE active subscription. Runs in a transaction with a
   * pessimistic lock and re-checks state, so two concurrent readers can never
   * both expire the same row or double-emit audit events.
   */
  async expireIfDue(subscriptionId: string): Promise<boolean> {
    const now = new Date();
    return this.subscriptionsRepository.manager.transaction(async (manager) => {
      const repo = manager.getRepository(Subscription);
      const fresh = await repo.findOne({
        where: { id: subscriptionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!fresh || fresh.status !== 'active' || fresh.currentPeriodEnd > now) {
        return false;
      }
      assertSubscriptionTransition(fresh.status, 'expired');
      fresh.status = 'expired';
      await repo.save(fresh);
      await this.auditService.record(
        AuditEventType.SUBSCRIPTION_EXPIRED,
        { target: `subscription:${fresh.id}`, metadata: { userId: fresh.userId } },
        manager,
      );
      await this.auditService.record(
        AuditEventType.ACCESS_REVOKED,
        {
          target: `user:${fresh.userId}`,
          metadata: { userId: fresh.userId, reason: 'subscription-expired' },
        },
        manager,
      );
      await this.syncUserPlan(fresh.userId, 'free', manager);
      return true;
    });
  }

  /** User- or admin-requested immediate cancellation. */
  async cancel(subscriptionId: string, actorId: string, actor: string | null): Promise<void> {
    const subscription = await this.subscriptionsRepository.findOne({
      where: { id: subscriptionId },
    });
    if (!subscription) {
      return;
    }
    assertSubscriptionTransition(subscription.status, 'cancelled');
    subscription.status = 'cancelled';
    subscription.cancelledAt = new Date();
    await this.subscriptionsRepository.save(subscription);
    await this.auditService.record(AuditEventType.SUBSCRIPTION_CANCELLED, {
      actorId,
      actor,
      target: `subscription:${subscription.id}`,
      metadata: { userId: subscription.userId, reason: 'user-requested' },
    });
    await this.auditService.record(AuditEventType.ACCESS_REVOKED, {
      actorId,
      actor,
      target: `user:${subscription.userId}`,
      metadata: { userId: subscription.userId, reason: 'subscription-cancelled' },
    });
    await this.syncUserPlan(subscription.userId, 'free');
  }

  /**
   * Active subscription for the user whose period has NOT ended, or null.
   * Overdue rows are expired on the way (lazy expiration, INV-06).
   */
  async getActiveOrExpire(userId: string): Promise<Subscription | null> {
    const active = await this.subscriptionsRepository.find({
      where: { userId, status: 'active' },
      order: { createdAt: 'DESC' },
    });
    const now = new Date();
    let current: Subscription | null = null;
    for (const subscription of active) {
      if (subscription.currentPeriodEnd <= now) {
        const expired = await this.expireIfDue(subscription.id);
        if (expired) {
          this.logger.log(`SubscriptionExpired subscriptionId=${subscription.id} userId=${userId}`);
        }
        continue;
      }
      // INV-01 backstop: if the partial index was bypassed, keep only the newest.
      if (!current || subscription.createdAt > current.createdAt) {
        current = subscription;
      }
    }
    return current;
  }

  /** Admin overview listing with optional filters. */
  async listAll(filters: { status?: string; userId?: string; limit?: number } = {}): Promise<Subscription[]> {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const qb = this.subscriptionsRepository
      .createQueryBuilder('subscription')
      .orderBy('subscription.createdAt', 'DESC')
      .take(limit);
    if (filters.status) {
      qb.andWhere('subscription.status = :status', { status: filters.status });
    }
    if (filters.userId) {
      qb.andWhere('subscription.userId = :userId', { userId: filters.userId });
    }
    return qb.getMany();
  }
}
