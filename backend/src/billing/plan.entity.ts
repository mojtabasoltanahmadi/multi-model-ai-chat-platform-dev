import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Admin-configurable billing period. Period length in days derives from it. */
export type BillingPeriod = 'monthly' | 'yearly';

export const BILLING_PERIOD_DAYS: Record<BillingPeriod, number> = {
  monthly: 30,
  yearly: 365,
};

/**
 * A purchasable plan. NOTHING about access is hard-coded per plan name: every
 * capability is a column here, and EntitlementsService reads them fresh from
 * this table. Adding a plan = inserting a row, never new business logic.
 */
@Entity('plans')
@Index('idx_plans_active', ['isActive'])
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Stable unique identifier used in code/logs only — never in access logic. */
  @Column({ type: 'varchar', length: 50, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  /** Authoritative price — the client never sends amounts. numeric → string. */
  @Column({ type: 'numeric', precision: 14, scale: 6, default: 0 })
  price: string;

  @Column({ type: 'varchar', length: 10, default: 'IRT' })
  currency: string;

  @Column({ type: 'varchar', length: 20, default: 'monthly' })
  billingPeriod: BillingPeriod;

  /** Daily message quota. Required — matches the existing PlanQuota shape. */
  @Column({ name: 'daily_message_quota', type: 'integer' })
  dailyMessageQuota: number;

  /** Daily token quota (input + output); null = unlimited. */
  @Column({ name: 'daily_token_quota', type: 'integer', nullable: true })
  dailyTokenQuota: number | null;

  /**
   * Model ids the plan may use; null = all active models (free-tier behavior
   * stays governed by AiModel.isFree + the user's tier, as before).
   */
  @Column({ name: 'allowed_model_ids', type: 'jsonb', nullable: true, default: '[]' })
  allowedModelIds: string[] | null;

  @Column({ name: 'web_search', type: 'boolean', default: false })
  webSearch: boolean;

  @Column({ type: 'boolean', default: false })
  thinking: boolean;

  @Column({ name: 'file_processing', type: 'boolean', default: false })
  fileProcessing: boolean;

  /**
   * Deactivated plans cannot be purchased. Existing active subscriptions keep
   * their entitlements until period end (documented policy — see the billing
   * decisions doc); historical payments are never rewritten.
   */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
