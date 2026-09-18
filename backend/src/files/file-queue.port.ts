/**
 * Queue port (dependency inversion).
 *
 * Consumers (FilesService, FileProcessingService, the admin controller) depend
 * on this interface instead of the BullMQ adapter. Two reasons:
 *   - the processing logic stays unit-testable with a plain object stub, and
 *   - BullMQ's Nest integration ships ESM-only, which the Jest CJS runtime
 *     cannot load; keeping it behind the adapter confines it to the wiring.
 */

/** Queue name used by the producer and the worker. */
export const FILE_PROCESSING_QUEUE = 'file-processing';

/** Injection token for the queue port implementation. */
export const FILE_JOB_QUEUE = 'FILE_JOB_QUEUE';

export interface QueueJobCounts {
  waiting: number;
  active: number;
  failed: number;
  completed: number;
}

export interface FileJobQueue {
  /** Enqueues a processing job for one file; safe to call repeatedly. */
  enqueueProcessing(fileId: string): Promise<void>;
  /** Live queue depth for the admin panel. */
  getJobCounts(): Promise<QueueJobCounts>;
}
