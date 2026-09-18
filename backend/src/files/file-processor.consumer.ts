import { Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { FILE_PROCESSING_QUEUE } from './file-queue.port';
import { FileProcessingService } from './file-processing.service';

export interface FileProcessingJob {
  fileId: string;
}

/**
 * BullMQ transport adapter. Deliberately thin: the real work (claim,
 * extract, persist, retry classification) lives in FileProcessingService,
 * which keeps it unit-testable without the queue runtime.
 *
 * Concurrency 2 lets one slow file (OCR) coexist with quick PDF/Excel jobs.
 */
@Processor(FILE_PROCESSING_QUEUE, { concurrency: 2 })
@Injectable()
export class FileProcessor extends WorkerHost {
  private readonly logger = new Logger(FileProcessor.name);

  constructor(private readonly processing: FileProcessingService) {
    super();
  }

  async process(job: Job<FileProcessingJob>): Promise<void> {
    await this.processing.processFile({
      fileId: job?.data?.fileId,
      jobId: job?.id,
      attemptsMade: job?.attemptsMade ?? 0,
      maxAttempts: job?.opts?.attempts ?? 1,
    });
  }

  @OnWorkerEvent('failed')
  onJobFailed(job: Job<FileProcessingJob>, error: Error): void {
    this.logger.error(
      `file.processing.job_failed fileId=${job?.data?.fileId} jobId=${job?.id} attempts=${job?.attemptsMade}: ${error?.message}`,
    );
  }

  @OnWorkerEvent('error')
  onWorkerError(error: Error): void {
    this.logger.error(`file.processing.worker_error: ${error?.message}`);
  }
}
