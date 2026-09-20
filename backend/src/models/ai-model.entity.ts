import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ModelCapability } from './model-capabilities';

/**
 * Supported provider kinds — one entry per registered adapter
 * (`backend/src/ai/adapters/`):
 * - mock: streams a canned response (demo & tests, no external dependency)
 * - openai-compatible: any OpenAI-compatible /chat/completions streaming API
 * - anthropic: Claude via the native Messages API
 * - google: Gemini via `streamGenerateContent`
 * Adding a kind = new adapter class + this union + the DTO `IsIn` lists.
 */
export type AiProviderKind =
  | 'mock'
  | 'openai-compatible'
  | 'anthropic'
  | 'google';

@Entity('ai_models')
export class AiModel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 40 })
  provider: AiProviderKind;

  /** Model identifier at the provider, e.g. "gpt-4o-mini" (ignored by mock). */
  @Column({ name: 'external_model_id', type: 'varchar', length: 200 })
  externalModelId: string;

  /**
   * Optional API base URL override; each adapter falls back to its provider's
   * default endpoint when null.
   */
  @Column({ name: 'base_url', type: 'varchar', length: 500, nullable: true })
  baseUrl: string | null;

  /** Provider API key. Never returned to clients. */
  @Column({ name: 'api_key', type: 'varchar', length: 500, nullable: true })
  apiKey: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  /**
   * Whether the model is available to users on the FREE plan (the only plan
   * in the MVP). Independent of isActive: a model can be free-configured but
   * temporarily disabled. The default model must be active AND free.
   */
  @Column({ name: 'is_free', type: 'boolean', default: true })
  isFree: boolean;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean;

  /**
   * Optional single-hop fallback model (day-7-8 contract §12), admin-set.
   * When the provider of THIS model fails with a retryable kind BEFORE the
   * first streamed token, the turn restarts once on this model. Rules
   * enforced at the admin boundary: must exist, be active, not self, and be
   * at least as accessible as the primary (a free user must never fall back
   * into a 403). Null ⇒ no fallback.
   */
  @Index()
  @Column({ name: 'fallback_model_id', type: 'uuid', nullable: true })
  fallbackModelId: string | null;

  @ManyToOne(() => AiModel, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'fallback_model_id' })
  fallbackModel: AiModel | null;

  /**
   * Declared capabilities from the closed set `MODEL_CAPABILITIES`
   * (jsonb, validated at the admin boundary — no DB constraint). Capabilities
   * only *unlock* opt-in features for a model; they never gate the base turn.
   */
  @Column({ type: 'jsonb', default: '[]' })
  capabilities: ModelCapability[];

  /**
   * Pricing in Toman per 1M tokens (day-7-8 contract §15; precision widened
   * from the contract's (12,6) to (14,6) so a 1M-Toman price — 7 integer
   * digits — fits). Null ⇒ no cost is computed for this model. Exposed to
   * ADMIN endpoints only (INV-14) — SafeModel strips both fields.
   */
  @Column({ name: 'input_price_per_million', type: 'numeric', precision: 14, scale: 6, nullable: true })
  inputPricePerMillion: string | null;

  @Column({ name: 'output_price_per_million', type: 'numeric', precision: 14, scale: 6, nullable: true })
  outputPricePerMillion: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
