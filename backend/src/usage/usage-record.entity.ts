import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { AiProviderKind } from '../models/ai-model.entity';
import type { UserPlan } from '../users/user.entity';

/**
 * Lifecycle of one usage record.
 *  - 'pending'     : turn accepted, generation in flight (counted for quota)
 *  - 'completed'   : generation finished successfully (counted for quota)
 *  - 'interrupted' : generation died server-side (process restart); tokens
 *                    already consumed are counted for quota
 *  - 'failed'      : provider/model failed; recorded for cost accounting but
 *                    does NOT consume the message quota (failed turns are
 *                    retried for free — the retry reuses this same row)
 */
export type UsageOutcome = 'pending' | 'completed' | 'failed' | 'interrupted';

/**
 * One row per ACCEPTED chat turn (day-7-8 contract §15). The UNIQUE
 * message_id is the dedupe anchor (INV-6/7): replays reuse the user row, so
 * a turn can never be recorded twice — the unique key makes double-billing
 * structurally impossible, no locks needed.
 */
@Entity('usage_records')
@Index('idx_usage_user_created', ['userId', 'createdAt'])
export class UsageRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  @Column({ name: 'message_id', type: 'uuid', unique: true })
  messageId: string;

  /** Model actually used for the turn; NULL after a model deletion (SET NULL). */
  @Column({ name: 'model_id', type: 'uuid', nullable: true })
  modelId: string | null;

  @Column({ type: 'varchar', length: 40 })
  provider: AiProviderKind;

  /** Provider-reported tokens; NULL when the provider reports no usage. */
  @Column({ name: 'input_tokens', type: 'int', nullable: true })
  inputTokens: number | null;

  @Column({ name: 'output_tokens', type: 'int', nullable: true })
  outputTokens: number | null;

  @Column({ name: 'input_chars', type: 'int', default: 0 })
  inputChars: number;

  @Column({ name: 'output_chars', type: 'int', default: 0 })
  outputChars: number;

  /** Toman, computed at terminal from the model's pricing; NULL when unpriced. */
  @Column({ type: 'numeric', precision: 14, scale: 6, nullable: true })
  cost: string | null;

  /** True when tokens are a chars/4 estimate (provider reported no usage). */
  @Column({ type: 'boolean', default: false })
  estimated: boolean;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  outcome: UsageOutcome;

  /** Turn acceptance time — also the bucketing key for the daily quota. */
  @CreateDateColumn()
  createdAt: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}

/** Quota plan descriptor (per-request limits; see configuration.ts quota). */
export interface PlanQuota {
  dailyMessages: number;
  dailyTokens: number | null;
}

export type { UserPlan };
