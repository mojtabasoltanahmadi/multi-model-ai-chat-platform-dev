import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type WebhookEventStatus = 'received' | 'processed' | 'ignored' | 'failed';

/**
 * Persisted webhook inbox. INV-02/INV-04 idempotency anchor: the composite
 * unique (provider, event_id) guarantees a given gateway event can occupy the
 * inbox only once; processing happens ONLY when the insert wins the race, so
 * a concurrent duplicate can never produce a second business effect.
 */
@Entity('webhook_events')
@Index('uq_webhook_events_provider_event', ['provider', 'eventId'], { unique: true })
export class WebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Gateway event id from the payload — NOT the row id. */
  @Column({ name: 'event_id', type: 'varchar', length: 100 })
  eventId: string;

  @Column({ type: 'varchar', length: 30, default: 'simulator' })
  provider: string;

  @Column({ name: 'event_type', type: 'varchar', length: 60 })
  eventType: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'varchar', length: 20, default: 'received' })
  status: WebhookEventStatus;

  /** Why an event was ignored (unknown type / stale state) — for audit. */
  @Column({ name: 'ignore_reason', type: 'varchar', length: 255, nullable: true })
  ignoreReason: string | null;

  @Column({ name: 'error', type: 'varchar', length: 255, nullable: true })
  error: string | null;

  @CreateDateColumn({ name: 'received_at' })
  receivedAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}
