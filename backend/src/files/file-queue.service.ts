import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  FILE_PROCESSING_QUEUE,
  FileJobQueue,
  QueueJobCounts,
} from './file-queue.port';

/**
 * BullMQ-backed implementation of the queue port. Jobs carry only the file
 * id — the binary never enters Redis; the worker re-reads the object from
 * MinIO.
 */
@Injectable()
export class FileQueueService implements FileJobQueue {
  private readonly logger = new Logger(FileQueueService.name);

  constructor(@InjectQueue(FILE_PROCESSING_QUEUE) private readonly queue: Queue) {}

  async enqueueProcessing(fileId: string): Promise<void> {
    // A terminal job with this id would make BullMQ silently IGNORE the add
    // below, leaving the row PROCESSING with no job behind it (a stuck state).
    // Clear terminal jobs first, then dedupe against live ones as usual.
    const existing = await this.queue.getJob(fileId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') {
        await existing.remove().catch(() => undefined);
      } else {
        // waiting / active / delayed: a live job already covers this file.
        return;
      }
    }

    await this.queue.add(
      'process',
      { fileId },
      {
        // Using the file id as jobId makes duplicate enqueues (upload retry,
        // orphan sweeper) collapse into the single pending job.
        jobId: fileId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600 },
      },
    );
    this.logger.log(`file.processing.enqueued fileId=${fileId}`);
  }

  async getJobCounts(): Promise<QueueJobCounts> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'failed', 'completed');
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
    };
  }
}
