import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Plan } from './plan.entity';

export type PaymentStatus = 'pending' | 'success' | 'failed' | 'cancelled';

/**
 * Payment state machine. Enforced by PaymentsService.assertTransition; there
 * is no arbitrary status mutation anywhere (SUCCESS → PENDING is impossible).
 *
 * pending  → success | failed | cancelled
 * success  → terminal
 * failed   → terminal (a retry is a NEW payment)
 * cancelled→ terminal
 */
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  pending: ['success', 'failed', 'cancelled'],
  success: [],
  failed: [],
  cancelled: [],
};

/** Frozen plan facts at purchase time — INV-07 historical integrity. */
export interface PlanSnapshot {
  planId: string;
  planSlug: string;
  planName: string;
  price: string;
  currency: string;
  billingPeriod: Plan['billingPeriod'];
}

/**
 * INV-09: every payment traces to its user, plan (snapshot + fk) and, once a
 * webhook lands, to the webhook_events rows via payload.paymentId. The
 * partial unique index makes a duplicate PENDING payment for the same
 * (user, plan) impossible — the "double-click on Pay" race is settled by the
 * database, with a friendly service-level check in front of it.
 */
@Entity('payments')
@Index('idx_payments_user', ['userId'])
@Index('uq_payments_user_plan_pending', ['userId', 'planId'], {
  unique: true,
  where: `"status" = 'pending'`,
})
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'plan_id', type: 'uuid' })
  planId: string;

  /** Authoritative amount resolved from the Plan row server-side. */
  @Column({ type: 'numeric', precision: 14, scale: 6 })
  amount: string;

  @Column({ type: 'varchar', length: 10 })
  currency: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: PaymentStatus;

  /** Immutable copy of the plan facts used for this payment (INV-07). */
  @Column({ name: 'plan_snapshot', type: 'jsonb' })
  planSnapshot: PlanSnapshot;

  /** Simulator/gateway correlation reference shown to the user. */
  @Column({ name: 'tracking_id', type: 'varchar', length: 64, unique: true })
  trackingId: string;

  /** Simulator scenario applied to this payment (null = organic flow). */
  @Column({ type: 'varchar', length: 40, nullable: true })
  scenario: string | null;

  @Column({ name: 'failure_reason', type: 'varchar', length: 255, nullable: true })
  failureReason: string | null;

  @Column({ name: 'succeeded_at', type: 'timestamptz', nullable: true })
  succeededAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
