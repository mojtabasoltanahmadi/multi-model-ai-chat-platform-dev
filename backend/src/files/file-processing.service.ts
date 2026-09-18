import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { File, FileStatus } from './file.entity';
import { FILE_JOB_QUEUE, FileJobQueue } from './file-queue.port';
import { FileStorageService } from './file-storage.service';
import { FileExtractionService, PermanentExtractionError } from './file-extraction.service';
import { FileKind } from './file-validation';

/** Identifies the MIME type → extraction pipeline mapping. */
export function kindFromStoredMime(mimeType: string): FileKind | null {
  switch (mimeType) {
    case 'application/pdf':
      return 'pdf';
    case 'application/vnd.ms-excel':
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'excel';
    case 'image/png':
    case 'image/jpeg':
      return 'image';
    default:
      return null;
  }
}

/** The slice of a BullMQ job the processing logic needs (keeps it transport-free). */
export interface ProcessingJobContext {
  fileId: string;
  jobId?: string;
  attemptsMade: number;
  maxAttempts: number;
}

/**
 * The actual background work, independent of the queue transport (the thin
 * `FileProcessor` consumer adapts BullMQ jobs onto this service).
 *
 * Guarantees:
 *  - **Idempotent**: the status is claimed atomically (UPLOADING|PROCESSING →
 *    PROCESSING) with a conditional UPDATE, so duplicate job deliveries are
 *    skipped and a READY row is never reprocessed.
 *  - **Bounded retries**: transient failures (storage/network) are rethrown so
 *    BullMQ retries with exponential backoff; the final attempt marks FAILED.
 *    Permanent failures (corrupt/unreadable content) fail immediately.
 *  - **READY means processed**: the row flips to READY only with the extracted
 *    text persisted in the same update.
 */
@Injectable()
export class FileProcessingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FileProcessingService.name);
  private readonly processingTimeoutMs: number;
  private readonly staleProcessingMs: number;
  private readonly staleUploadingMs: number;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(File)
    private readonly filesRepository: Repository<File>,
    private readonly storage: FileStorageService,
    private readonly extraction: FileExtractionService,
    @Inject(FILE_JOB_QUEUE) private readonly queue: FileJobQueue,
    configService: ConfigService,
  ) {
    this.processingTimeoutMs = configService.get<number>('queue.processingTimeoutMs') ?? 120_000;
    this.staleProcessingMs = configService.get<number>('queue.staleProcessingMs') ?? 600_000;
    // Uploads whose enqueue failed (Redis hiccup) are retried sooner.
    this.staleUploadingMs = 120_000;
  }

  onModuleInit(): void {
    // Orphan sweeper: re-enqueues rows whose job was lost — a failed enqueue
    // after a successful upload (UPLOADING) or a worker crash mid-processing
    // (PROCESSING). Safe to repeat: the jobId is the file id (no duplicate
    // jobs) and processing itself is idempotent. `unref()` keeps the timer
    // from holding the process open.
    this.sweepTimer = setInterval(() => {
      void this.sweepOrphans();
    }, 60_000);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Re-enqueues rows that have no live job. Never throws. */
  async sweepOrphans(): Promise<number> {
    try {
      const now = Date.now();
      const uploadCutoff = new Date(now - this.staleUploadingMs);
      const processingCutoff = new Date(now - this.staleProcessingMs);

      const orphans = await this.filesRepository.find({
        where: [
          { status: 'UPLOADING' as FileStatus, updatedAt: LessThan(uploadCutoff) },
          { status: 'PROCESSING' as FileStatus, updatedAt: LessThan(processingCutoff) },
        ],
        take: 50,
      });

      for (const file of orphans) {
        // A PROCESSING row that already exhausted its attempts belongs in
        // FAILED; anything else gets a fresh chance.
        if (file.attempts >= 3) {
          await this.markFailed(file.id, 'پردازش فایل پس از چند تلاش ناموفق ماند.');
          continue;
        }
        this.logger.warn(
          `file.processing.orphan_recovered fileId=${file.id} status=${file.status} attempts=${file.attempts} conversationId=${file.conversationId}`,
        );
        await this.queue.enqueueProcessing(file.id);
      }
      return orphans.length;
    } catch (error) {
      this.logger.error(
        `file.processing.sweep_failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }

  /**
   * Processes one file. Resolves when the attempt finished; rejects only for
   * transient failures that BullMQ should retry.
   */
  async processFile(job: ProcessingJobContext): Promise<void> {
    const fileId = job?.fileId;
    if (!fileId) return;

    const file = await this.filesRepository.findOne({ where: { id: fileId } });
    if (!file) {
      this.logger.warn(`file.processing.skipped fileId=${fileId} reason=deleted`);
      return;
    }
    if (file.status === 'READY' || file.status === 'FAILED') {
      // Duplicate delivery of a finished job: keep the terminal state.
      this.logger.log(`file.processing.skipped fileId=${fileId} status=${file.status}`);
      return;
    }

    const kind = kindFromStoredMime(file.mimeType);
    if (!kind) {
      await this.markFailed(file.id, 'نوع فایل پشتیبانی نمی‌شود.');
      return;
    }

    // Atomic claim: only UPLOADING/PROCESSING may become PROCESSING. A second
    // worker (or duplicate job) finds `affected === 0` and backs off, so two
    // runs never process the same row concurrently.
    const claim = await this.filesRepository
      .createQueryBuilder()
      .update(File)
      .set({ status: 'PROCESSING' as FileStatus, attempts: () => 'attempts + 1' })
      .where('id = :id AND status IN (:...statuses)', {
        id: file.id,
        statuses: ['UPLOADING', 'PROCESSING'],
      })
      .execute();
    if (!claim.affected) {
      this.logger.log(`file.processing.skipped fileId=${fileId} reason=claimed_elsewhere`);
      return;
    }

    this.logger.log(
      `file.processing.started fileId=${file.id} userId=${file.userId} conversationId=${file.conversationId} jobId=${job.jobId} attempt=${job.attemptsMade + 1}`,
    );

    try {
      const buffer = await this.storage.getBuffer(file.storageKey);
      const { text } = await withTimeout(
        this.extraction.extract(kind, buffer),
        this.processingTimeoutMs,
        () => new Error('فایل بیش از حد طول کشید'),
      );

      // Content and state persist together: READY implies extracted content.
      await this.filesRepository.update(
        { id: file.id, status: 'PROCESSING' as FileStatus },
        { status: 'READY' as FileStatus, extractedText: text, errorMessage: null },
      );
      this.logger.log(`file.processing.completed fileId=${file.id} chars=${text.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PermanentExtractionError) {
        this.logger.warn(
          `file.processing.failed fileId=${file.id} permanent=true reason=${message}`,
        );
        await this.markFailed(file.id, message);
        return;
      }

      const attemptsMade = job.attemptsMade + 1; // this run counts as one
      if (attemptsMade >= job.maxAttempts) {
        this.logger.error(
          `file.processing.failed fileId=${file.id} attempts=${attemptsMade} reason=${message}`,
        );
        await this.markFailed(
          file.id,
          'پردازش فایل با خطای موقت ناموفق ماند. لطفاً دوباره تلاش کنید.',
        );
        return;
      }

      // Transient: let BullMQ apply the backoff and retry. The row stays
      // PROCESSING with its job alive — Processing Consistency holds.
      this.logger.warn(
        `file.processing.retry fileId=${file.id} attempt=${attemptsMade}/${job.maxAttempts} reason=${message}`,
      );
      throw error;
    }
  }

  /**
   * Marks the row FAILED with a safe, user-displayable reason. Failure info is
   * always persisted (Failure Consistency); internals stay in the logs.
   */
  private async markFailed(fileId: string, safeMessage: string): Promise<void> {
    const nonTerminal: FileStatus[] = ['UPLOADING', 'PROCESSING'];
    await this.filesRepository.update(
      { id: fileId, status: In(nonTerminal) },
      { status: 'FAILED' as FileStatus, errorMessage: safeMessage },
    );
  }
}

/**
 * Bounds a promise. The wrapped error is transient on purpose: a timeout may
 * be a slow machine, so BullMQ retries before the row is failed.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, createError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(createError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
