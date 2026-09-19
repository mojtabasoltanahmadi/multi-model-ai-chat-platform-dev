import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type SubscriptionStatus = 'pending' | 'active' | 'expired' | 'cancelled';

/**
 * Valid lifecycle transitions. Enforced by SubscriptionsService.assertTransition;
 * anything not listed here must never happen through application flows.
 *
 * pending   → active | cancelled
 * active    → expired | cancelled
 * expired   → terminal (renewal/upgrade always creates a NEW row)
 * cancelled → terminal
 */
export const SUBSCRIPTION_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  pending: ['active', 'cancelled'],
  active: ['expired', 'cancelled'],
  expired: [],
  cancelled: [],
};

/**
 * One subscription row per purchase. INV-01 (at most ONE active subscription
 * per user) is guaranteed by the partial unique index below AND re-checked
 * under lock inside the activation transaction — the index is the backstop,
 * never the only defense.
 */
@Entity('subscriptions')
@Index('idx_subscriptions_user', ['userId'])
@Index('uq_subscriptions_user_active', ['userId'], {
  unique: true,
  where: `"status" = 'active'`,
})
export class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'plan_id', type: 'uuid' })
  planId: string;

  /** Denormalized at activation from the Plan row for stable admin display. */
  @Column({ name: 'plan_slug', type: 'varchar', length: 50 })
  planSlug: string;

  @Column({ name: 'plan_name', type: 'varchar', length: 100 })
  planName: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: SubscriptionStatus;

  @Column({ name: 'current_period_start', type: 'timestamptz' })
  currentPeriodStart: Date;

  @Column({ name: 'current_period_end', type: 'timestamptz' })
  currentPeriodEnd: Date;

  /** Payment that activated this row (INV-09 traceability). */
  @Column({ name: 'source_payment_id', type: 'uuid', nullable: true })
  sourcePaymentId: string | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
