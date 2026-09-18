import { BadRequestException } from '@nestjs/common';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../users/user.entity';
import { Conversation } from '../conversations/conversation.entity';

/**
 * Lifecycle of an uploaded file. Enforced by `assertTransition`:
 *
 *   UPLOADING  → PROCESSING            (worker picked the job up)
 *   PROCESSING → READY                 (extraction persisted)
 *   PROCESSING → FAILED                (permanent / retries exhausted)
 *   READY      → PROCESSING            (explicit admin reprocess only)
 *   FAILED     → PROCESSING            (explicit admin reprocess only)
 *
 * UPLOADING is the initial state set inside the upload transaction — no job
 * exists yet, so nothing may jump straight to READY/FAILED.
 */
export type FileStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED';

/** Allowed transitions. Anything not listed here is a bug, not a state. */
export const FILE_STATUS_TRANSITIONS: Record<FileStatus, FileStatus[]> = {
  UPLOADING: ['PROCESSING'],
  PROCESSING: ['READY', 'FAILED'],
  READY: ['PROCESSING'], // reprocess (explicit only)
  FAILED: ['PROCESSING'], // reprocess (explicit only)
};

export function canTransition(from: FileStatus, to: FileStatus): boolean {
  return FILE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

@Entity('files')
@Index('idx_files_conversation_status', ['conversationId', 'status'])
@Index('idx_files_status_updated', ['status', 'updatedAt'])
export class File {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Index()
  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  @ManyToOne(() => Conversation, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'conversation_id' })
  conversation: Conversation;

  /** Client-supplied display name; sanitized, never used for storage paths. */
  @Column({ name: 'original_name', type: 'varchar', length: 255 })
  originalName: string;

  /** MIME type as validated (magic bytes first) at upload time. */
  @Column({ name: 'mime_type', type: 'varchar', length: 100 })
  mimeType: string;

  @Column({ type: 'integer' })
  size: number;

  /** MinIO object key: files/{userId}/{conversationId}/{uuid}.<ext> */
  @Column({ name: 'storage_key', type: 'varchar', length: 300 })
  storageKey: string;

  @Column({ type: 'varchar', length: 20, default: 'UPLOADING' })
  status: FileStatus;

  @Column({ name: 'extracted_text', type: 'text', nullable: true })
  extractedText: string | null;

  /**
   * Safe, user-displayable failure reason (Persian, like other client
   * messages). Stack traces and internal details live only in server logs.
   */
  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  /**
   * Number of processing attempts consumed by the current PROCESSING cycle.
   * Reset on explicit reprocess; used by the orphan sweeper for honest
   * reporting after a worker crash.
   */
  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /**
   * State machine gate for persisted writes. Use this (or the targeted
   * conditional update in the processor) whenever moving a file between
   * statuses so illegal transitions fail loudly.
   */
  assertTransition(to: FileStatus): void {
    if (!canTransition(this.status, to)) {
      throw new BadRequestException(
        `تغییر وضعیت فایل از ${this.status} به ${to} مجاز نیست.`,
      );
    }
    this.status = to;
  }
}
