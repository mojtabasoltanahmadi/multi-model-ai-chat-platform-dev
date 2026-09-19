import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Conversation } from '../conversations/conversation.entity';
import { AiModel } from '../models/ai-model.entity';
import type { MessageSource } from '../websearch/websearch.types';

export type MessageRole = 'user' | 'assistant';

/**
 * Status of a message:
 * - `completed`  AI finished the response cleanly.
 * - `interrupted` Stream ended because the client disconnected (or the user
 *                closed the tab). Partial content is preserved. User-facing
 *                recovery: Retry / Regenerate.
 * - `failed`     The AI provider / network itself failed (HTTP error, timeout,
 *                malformed SSE). Partial content is preserved. User-facing
 *                recovery: Retry.
 * - `pending`    The chat turn has been accepted and the assistant row has
 *                been pre-persisted but no AI chunk has arrived yet (transient;
 *                never observed after a successful connection).
 * - `streaming`  At least one AI chunk has been delivered (transient; never
 *                observed after a successful connection).
 *
 * `null` is reserved for user messages (whose status is irrelevant).
 */
export type MessageStatus =
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'interrupted'
  | 'failed';

@Entity('messages')
@Index('idx_messages_conv_role_clientmid', ['conversationId', 'role', 'clientMessageId'])
export class Message {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => Conversation, (conversation) => conversation.messages, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;

  @Column({ type: 'varchar', length: 20 })
  role: MessageRole;

  @Column({ type: 'text' })
  content: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  status: MessageStatus | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Index()
  @Column({ name: 'model_id', type: 'uuid', nullable: true })
  modelId: string | null;

  @ManyToOne(() => AiModel, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'model_id' })
  model: AiModel | null;

  /**
   * Optional idempotency token supplied by the client. Used by the chat
   * endpoint to recognize a retry of the same intent and reuse the original
   * user row instead of duplicating it. Set on user messages.
   */
  @Column({ name: 'client_message_id', type: 'varchar', length: 64, nullable: true })
  clientMessageId: string | null;

  /**
   * File ids this user message attached as AI context (null on assistant
   * rows). Only READY files are ever stored here; the ids let a refreshed
   * client render the attachment chips and lets a retry rebuild the same
   * context. The extracted text itself is never duplicated into the message.
   */
  @Column({ name: 'attached_file_ids', type: 'jsonb', nullable: true })
  attachedFileIds: string[] | null;

  /**
   * Web search sources cited by THIS assistant turn (null on user rows and
   * on turns answered without search). Persisted so history reloads render
   * citations without re-running a search (search runs only for new turns
   * with webSearch=true).
   */
  @Column({ type: 'jsonb', nullable: true })
  sources: MessageSource[] | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
