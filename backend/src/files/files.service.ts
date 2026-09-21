import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { EntityManager } from 'typeorm';
import type { Readable } from 'node:stream';
import { In, Repository } from 'typeorm';
import { File, FileStatus } from './file.entity';
import { FILE_JOB_QUEUE, FileJobQueue } from './file-queue.port';
import { FileStorageService } from './file-storage.service';
import { FileKind, sanitizeOriginalName, validateUploadedFile } from './file-validation';
import { DEFAULT_MAX_FILES_PER_MESSAGE } from '../config/configuration';
import { Message } from '../messages/message.entity';

/**
 * Shape returned by every file API. Neither the extracted text (potentially
 * huge, and only ever consumed server-side by the AI) nor the internal
 * storage key leaves the backend.
 */
export interface SafeFile {
  id: string;
  userId: string;
  conversationId: string;
  originalName: string;
  mimeType: string;
  size: number;
  status: FileStatus;
  errorMessage: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A READY file resolved for AI context (chat integration). */
export interface AttachedFileContext {
  id: string;
  originalName: string;
  mimeType: string;
  extractedText: string;
}

export interface UploadedFileInput {
  buffer: Buffer;
  declaredMime: string;
  originalName: string;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @InjectRepository(File)
    private readonly filesRepository: Repository<File>,
    private readonly storage: FileStorageService,
    @Inject(FILE_JOB_QUEUE) private readonly queue: FileJobQueue,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Upload flow (Section 11): validate → store → record → enqueue → respond.
   * Ordered so the two failure windows (storage-vs-DB, DB-vs-queue) are
   * observable and recoverable rather than silent (Section 31):
   *
   *   1. validate content/MIME/size (throws 400 before any side effect)
   *   2. store object in MinIO
   *   3. insert DB row in a short transaction (UPLOADING, no job yet)
   *      - if the insert fails, the stored object is removed (best effort)
   *   4. enqueue the processing job; on enqueue failure the row stays
   *      UPLOADING and the orphan sweeper re-enqueues it later
   */
  async upload(userId: string, conversationId: string, input: UploadedFileInput): Promise<SafeFile> {
    const maxFileSizeBytes =
      this.configService.get<number>('files.maxFileSizeBytes') ?? 10 * 1024 * 1024;

    // 1. Validate before touching storage or the database.
    const check = validateUploadedFile({
      declaredMime: input.declaredMime,
      originalName: input.originalName,
      size: input.buffer.length,
      maxFileSizeBytes,
      buffer: input.buffer,
    });

    // 2. Store the binary under a server-generated key (never the filename).
    const extension = extensionFromName(input.originalName, check.kind);
    const storageKey = this.storage.buildStorageKey(userId, conversationId, extension);
    await this.storage.putBuffer(storageKey, input.buffer, check.resolvedMime);

    // 3. DB record inside a transaction; roll the object back on failure.
    let file: File;
    try {
      file = await this.filesRepository.manager.transaction(async (entityManager: EntityManager) => {
        const repository = entityManager.getRepository(File);
        return repository.save(
          repository.create({
            userId,
            conversationId,
            originalName: sanitizeOriginalName(input.originalName),
            mimeType: check.resolvedMime,
            size: input.buffer.length,
            storageKey,
            status: 'UPLOADING' satisfies FileStatus,
          }),
        );
      });
    } catch (error) {
      this.logger.error(
        `file.upload.db_failed storageKey=${storageKey} userId=${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.storage.remove(storageKey); // no orphan objects for failed inserts
      throw error;
    }

    this.logger.log(
      `file.upload.completed fileId=${file.id} userId=${userId} conversationId=${conversationId} size=${file.size} mime=${file.mimeType}`,
    );

    // 4. Queue the job. Enqueue failure is recoverable: the row stays
    // UPLOADING and the sweeper re-enqueues it — the upload still succeeds.
    try {
      await this.queue.enqueueProcessing(file.id);
    } catch (error) {
      this.logger.error(
        `file.upload.enqueue_failed fileId=${file.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return this.toSafeFile(file);
  }

  /**
   * Ownership-safe load. Returns 404 (not 403) for foreign files so the
   * existence of other users' resources is never leaked — same convention
   * as ConversationsService.getOwned.
   */
  async getOwned(userId: string, fileId: string): Promise<File> {
    const file = await this.filesRepository.findOne({
      where: { id: fileId, userId },
    });
    if (!file) throw new NotFoundException('فایل پیدا نشد.');
    return file;
  }

  async getOwnedSafe(userId: string, fileId: string): Promise<SafeFile> {
    return this.toSafeFile(await this.getOwned(userId, fileId));
  }

  /**
   * Owner-only object stream for the content/download endpoint. Ownership is
   * checked first (404 for foreign files, no existence leak) and the object is
   * never buffered in memory — the caller has not flushed a response yet, so a
   * missing object still surfaces as a clean 404.
   */
  async getContent(userId: string, fileId: string): Promise<{ file: File; stream: Readable }> {
    const file = await this.getOwned(userId, fileId);
    try {
      const stream = await this.storage.getStream(file.storageKey);
      this.logger.log(`file.content.served fileId=${file.id} userId=${userId} size=${file.size}`);
      return { file, stream };
    } catch (error) {
      // The row exists but the object does not: a real inconsistency, and one
      // the admin file view can investigate. Never expose the storage key.
      this.logger.error(
        `file.content.missing fileId=${file.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new NotFoundException('محتوای این فایل در Storage پیدا نشد.');
    }
  }

  /** Safe shape for a list of files of one conversation (ownership pre-checked). */
  listForConversation(conversationId: string): Promise<File[]> {
    return this.filesRepository.find({
      where: { conversationId },
      order: { createdAt: 'ASC' },
    });
  }

  safeList(files: File[]): SafeFile[] {
    return files.map((file) => this.toSafeFile(file));
  }

  /**
   * Resolves files for AI context — the single gate for using file content.
   *
   * Two conditions are enforced together in the query (never as a post-check):
   *   1. the file belongs to THIS conversation (chat isolation), and
   *   2. the file is READY.
   * Either violation rejects the whole send, so a PROCESSING/FAILED/foreign
   * file can never reach the model.
   */
  async getReadyContext(
    conversationId: string,
    fileIds: string[],
  ): Promise<AttachedFileContext[]> {
    if (fileIds.length === 0) return [];
    const maxFilesPerMessage =
      this.configService.get<number>('files.maxFilesPerMessage') ?? DEFAULT_MAX_FILES_PER_MESSAGE;
    if (fileIds.length > maxFilesPerMessage) {
      throw new BadRequestException(
        `حداکثر ${maxFilesPerMessage} فایل می‌تواند در هر پیام پیوست شود.`,
      );
    }

    const files = await this.filesRepository.find({
      where: { conversationId, id: In(fileIds) },
    });
    const byId = new Map(files.map((file) => [file.id, file]));

    const context: AttachedFileContext[] = [];
    for (const fileId of fileIds) {
      const file = byId.get(fileId);
      if (!file) {
        // Unknown id, or a file of another conversation/user: the same 400 for
        // both, so the API never confirms that a foreign file exists.
        throw new BadRequestException('فایل پیوست پیدا نشد یا به این گفتگو تعلق ندارد.');
      }
      if (file.status === 'UPLOADING' || file.status === 'PROCESSING') {
        throw new BadRequestException(
          'این فایل هنوز در حال پردازش است. لطفاً پس از تکمیل پردازش دوباره تلاش کنید.',
        );
      }
      if (file.status === 'FAILED') {
        throw new BadRequestException(
          'پردازش این فایل ناموفق بوده است و نمی‌تواند به‌عنوان محتوا استفاده شود.',
        );
      }
      context.push({
        id: file.id,
        originalName: file.originalName,
        mimeType: file.mimeType,
        extractedText: file.extractedText ?? '',
      });
    }
    return context;
  }

  /**
   * Admin reprocess: READY/FAILED → PROCESSING + fresh job. Returns null
   * when the file is not in a reprocessable state (caller decides the HTTP
   * outcome). Ownership is the caller's concern; this only enforces state.
   */
  async reprocess(adminUserId: string, fileId: string): Promise<SafeFile | null> {
    const file = await this.filesRepository.findOne({ where: { id: fileId } });
    if (!file) throw new NotFoundException('فایل پیدا نشد.');
    if (file.status !== 'READY' && file.status !== 'FAILED') {
      throw new BadRequestException('فقط فایل‌های READY یا FAILED قابل پردازش مجدد هستند.');
    }
    // READY → PROCESSING and FAILED → PROCESSING are both legal transitions.
    file.assertTransition('PROCESSING');
    file.attempts = 0;
    file.errorMessage = null;
    await this.filesRepository.save(file);
    await this.queue.enqueueProcessing(file.id);
    this.logger.log(`file.reprocess fileId=${fileId} adminId=${adminUserId}`);
    return this.toSafeFile(file);
  }

  /**
   * Owner retry for a FAILED file: the same file identity is reused — no new
   * row, no new storage object (Section 8 retry semantics). The state machine
   * allows only FAILED → PROCESSING here, so a READY or still-running file
   * can never be double-processed. On enqueue failure the row is put back to
   * FAILED (a legal transition) and a 503 is returned: the UI must not show
   * PROCESSING with no job behind it.
   */
  async retryProcessing(userId: string, fileId: string): Promise<SafeFile> {
    const file = await this.getOwned(userId, fileId);
    if (file.status !== 'FAILED') {
      throw new BadRequestException('فقط فایل‌های ناموفق قابل پردازش مجدد هستند.');
    }
    file.assertTransition('PROCESSING');
    file.attempts = 0;
    file.errorMessage = null;
    await this.filesRepository.save(file);

    try {
      await this.queue.enqueueProcessing(file.id);
    } catch (error) {
      this.logger.error(
        `file.retry.enqueue_failed fileId=${fileId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.filesRepository.update(
        { id: file.id, status: 'PROCESSING' as FileStatus },
        {
          status: 'FAILED' as FileStatus,
          errorMessage: 'شروع پردازش مجدد ناموفق بود. لطفاً دوباره تلاش کنید.',
        },
      );
      throw new HttpException(
        'شروع پردازش مجدد ناموفق بود. لطفاً دوباره تلاش کنید.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    this.logger.log(`file.retry fileId=${fileId} userId=${userId} conversationId=${file.conversationId}`);
    return this.toSafeFile(file);
  }

  /**
   * Deletes a file the caller owns, provided no persisted message references
   * it: a file attached to a sent message is part of the chat history and
   * cannot be withdrawn (the reference lives in messages.attached_file_ids).
   * The row goes first — a database failure aborts the whole delete, so the
   * record stays retryable — then the object, best effort: a failed object
   * removal only leaves a logged orphan object, never a database row pointing
   * at storage that is gone.
   */
  async deleteOwned(userId: string, fileId: string): Promise<void> {
    const file = await this.getOwned(userId, fileId);

    const messagesRepository = this.filesRepository.manager.getRepository(Message);
    const referenced = await messagesRepository
      .createQueryBuilder('message')
      .where('message.conversationId = :conversationId', { conversationId: file.conversationId })
      .andWhere('message.attachedFileIds @> CAST(:ids AS jsonb)', {
        ids: JSON.stringify([file.id]),
      })
      .getExists();
    if (referenced) {
      throw new BadRequestException('این فایل به یک پیام پیوست شده و قابل حذف نیست.');
    }

    await this.filesRepository.remove(file);
    await this.storage.remove(file.storageKey);
    this.logger.log(
      `file.deleted fileId=${file.id} userId=${userId} conversationId=${file.conversationId} status=${file.status}`,
    );
  }

  /** Admin list with filters; joins user/conversation ids for display. */
  async listForAdmin(options: {
    status?: FileStatus;
    limit: number;
    offset: number;
  }): Promise<{ items: File[]; total: number }> {
    const where = options.status ? { status: options.status } : {};
    const [items, total] = await this.filesRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: Math.min(options.limit, 200),
      skip: options.offset,
      relations: ['user', 'conversation'],
    });
    return { items, total };
  }

  async countByStatus(): Promise<Record<FileStatus, number> & { total: number }> {
    const grouped = await this.filesRepository
      .createQueryBuilder('file')
      .select('file.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('file.status')
      .getRawMany<{ status: FileStatus; count: string }>();

    const result = { UPLOADING: 0, PROCESSING: 0, READY: 0, FAILED: 0, total: 0 } as Record<
      FileStatus,
      number
    > & { total: number };
    for (const row of grouped) {
      result[row.status] = parseInt(row.count, 10) || 0;
      result.total += result[row.status];
    }
    return result;
  }

  toSafeFile(file: File): SafeFile {
    return {
      id: file.id,
      userId: file.userId,
      conversationId: file.conversationId,
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      status: file.status,
      errorMessage: file.errorMessage,
      attempts: file.attempts,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    };
  }
}

function extensionFromName(name: string, kind: FileKind): string {
  const fallback: Record<FileKind, string> = { pdf: 'pdf', excel: 'xlsx', image: 'png' };
  const match = /\.([a-z0-9]{1,10})$/i.exec(name.trim());
  if (!match) return fallback[kind];
  return match[1].toLowerCase();
}
