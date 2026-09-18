import {
  Column,
  CreateDateColumn,
  Entity,
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
   * Declared capabilities from the closed set `MODEL_CAPABILITIES`
   * (jsonb, validated at the admin boundary — no DB constraint). Capabilities
   * only *unlock* opt-in features for a model; they never gate the base turn.
   */
  @Column({ type: 'jsonb', default: '[]' })
  capabilities: ModelCapability[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
