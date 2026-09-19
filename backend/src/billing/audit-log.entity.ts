import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Append-only audit trail (INV-08). The application exposes NO update or
 * delete path for this table — services only ever insert. Secrets, tokens
 * and payment credentials must never be placed in metadata.
 */
@Entity('audit_logs')
@Index('idx_audit_logs_event_type', ['eventType'])
@Index('idx_audit_logs_created_at', ['createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'event_type', type: 'varchar', length: 60 })
  eventType: string;

  /** Actor user id (null = system / webhook). */
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  /** Human-readable actor label, e.g. an email or 'system'. */
  @Column({ name: 'actor', type: 'varchar', length: 255, nullable: true })
  actor: string | null;

  /** Subject of the event, e.g. 'payment:<id>' or 'plan:<id>'. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  target: string | null;

  /** Cross-reference id (payment id, webhook event id, …) — INV-09. */
  @Column({ name: 'correlation_id', type: 'varchar', length: 100, nullable: true })
  correlationId: string | null;

  /** Structured context. NEVER contains secrets or credentials. */
  @Column({ type: 'jsonb', default: '{}' })
  metadata: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}

/** Every audit event the billing subsystem can emit. */
export const AuditEventType = {
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_CANCELLED: 'payment.cancelled',
  WEBHOOK_RECEIVED: 'webhook.received',
  WEBHOOK_DUPLICATE: 'webhook.duplicate',
  WEBHOOK_IGNORED: 'webhook.ignored',
  SUBSCRIPTION_ACTIVATED: 'subscription.activated',
  SUBSCRIPTION_EXPIRED: 'subscription.expired',
  SUBSCRIPTION_CANCELLED: 'subscription.cancelled',
  PLAN_CREATED: 'plan.created',
  PLAN_UPDATED: 'plan.updated',
  PLAN_ACTIVATED: 'plan.activated',
  PLAN_DEACTIVATED: 'plan.deactivated',
  ACCESS_GRANTED: 'access.granted',
  ACCESS_REVOKED: 'access.revoked',
} as const;
