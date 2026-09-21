import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { File, FileStatus } from './file.entity';
import { FileExtractionService, PermanentExtractionError } from './file-extraction.service';
import { FileProcessingService } from './file-processing.service';
import { FileJobQueue, QueueJobCounts } from './file-queue.port';
import { FileStorageService } from './file-storage.service';

interface UpdateCall {
  criteria: unknown;
  patch: Record<string, unknown>;
}

function makeFile(overrides: Partial<File> = {}): File {
  const file = new File();
  Object.assign(
    file,
    {
      id: 'file-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      originalName: 'report.pdf',
      mimeType: 'application/pdf',
      size: 100,
      storageKey: 'files/user-1/conv-1/key.pdf',
      status: 'PROCESSING' as FileStatus,
      extractedText: null,
      errorMessage: null,
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    overrides,
  );
  return file;
}

function makeJob(attemptsMade = 0, maxAttempts = 3) {
  return { fileId: 'file-1', jobId: 'job-1', attemptsMade, maxAttempts };
}

function setup(options: { file?: File | null; claimAffected?: number } = {}) {
  const file = options.file === undefined ? makeFile() : options.file;
  const updates: UpdateCall[] = [];
  const executes: unknown[] = [];

  const queryBuilder = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(async () => {
      executes.push(true);
      return { affected: options.claimAffected ?? 1 };
    }),
  };

  const repository = {
    findOne: jest.fn().mockResolvedValue(file),
    update: jest.fn(async (criteria: unknown, patch: Record<string, unknown>) => {
      updates.push({ criteria, patch });
    }),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(() => queryBuilder),
  };

  const storage = {
    getBuffer: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 test')),
  };
  const extraction = {
    extract: jest.fn().mockResolvedValue({ text: 'extracted text' }),
  };
  // Plain stub of the queue PORT — no BullMQ (ESM) in the unit-test path.
  const queue: FileJobQueue & { enqueueProcessing: jest.Mock } = {
    enqueueProcessing: jest.fn().mockResolvedValue(undefined),
    getJobCounts: jest.fn(async (): Promise<QueueJobCounts> => ({ waiting: 0, active: 0, failed: 0, completed: 0 })),
  };
  const configService = {
    get: (key: string) =>
      ({
        'queue.processingTimeoutMs': 5000,
        'queue.staleProcessingMs': 600000,
      })[key],
  } as unknown as ConfigService;

  const processor = new FileProcessingService(
    repository as unknown as Repository<File>,
    storage as unknown as FileStorageService,
    extraction as unknown as FileExtractionService,
    queue,
    configService,
  );

  return { processor, repository, storage, extraction, queue, queryBuilder, updates, executes };
}

describe('FileProcessingService — processing a job', () => {
  it('processes an UPLOADING/PROCESSING file to READY with the extracted text', async () => {
    const { processor, extraction, updates, storage } = setup();

    await processor.processFile(makeJob());

    expect(storage.getBuffer).toHaveBeenCalledWith('files/user-1/conv-1/key.pdf');
    expect(extraction.extract).toHaveBeenCalledWith(
      'pdf',
      expect.any(Buffer),
      expect.objectContaining({ fileId: 'file-1', attempt: 1 }),
    );
    const readyUpdate = updates.find((call) => call.patch.status === 'READY');
    expect(readyUpdate?.patch).toMatchObject({ extractedText: 'extracted text', errorMessage: null });
  });

  it('skips a READY file (duplicate job delivery) without touching storage', async () => {
    const { processor, storage, extraction, updates } = setup({
      file: makeFile({ status: 'READY', extractedText: 'previous' }),
    });

    await processor.processFile(makeJob());

    expect(storage.getBuffer).not.toHaveBeenCalled();
    expect(extraction.extract).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('skips a FAILED file: only an explicit reprocess may restart it', async () => {
    const { processor, storage, updates } = setup({ file: makeFile({ status: 'FAILED' }) });

    await processor.processFile(makeJob());

    expect(storage.getBuffer).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('skips silently when the file record no longer exists', async () => {
    const { processor, storage } = setup({ file: null });

    await expect(processor.processFile(makeJob())).resolves.toBeUndefined();
    expect(storage.getBuffer).not.toHaveBeenCalled();
  });

  it('stops when another worker already claimed the row (atomic claim)', async () => {
    const { processor, storage, updates } = setup({ claimAffected: 0 });

    await processor.processFile(makeJob());

    expect(storage.getBuffer).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('marks FAILED without retrying on a permanent extraction failure', async () => {
    const { processor, extraction, updates } = setup();
    extraction.extract.mockRejectedValue(
      new PermanentExtractionError('فایل PDF خراب است یا قابل خواندن نیست.'),
    );

    // Swallowing the error (instead of rethrowing) is what suppresses retries.
    await expect(processor.processFile(makeJob())).resolves.toBeUndefined();

    const failed = updates.find((call) => call.patch.status === 'FAILED');
    expect(failed?.patch.errorMessage).toBe('فایل PDF خراب است یا قابل خواندن نیست.');
  });

  it('rethrows transient failures while retries remain (BullMQ backoff)', async () => {
    const { processor, extraction, updates } = setup();
    extraction.extract.mockRejectedValue(new Error('ECONNREFUSED minio'));

    await expect(processor.processFile(makeJob(0, 3))).rejects.toThrow('ECONNREFUSED minio');
    // Still PROCESSING with an active job — the Processing Consistency invariant.
    expect(updates.find((call) => call.patch.status === 'FAILED')).toBeUndefined();
  });

  it('marks FAILED once the last attempt fails', async () => {
    const { processor, extraction, updates } = setup();
    extraction.extract.mockRejectedValue(new Error('ECONNREFUSED minio'));

    await expect(processor.processFile(makeJob(2, 3))).resolves.toBeUndefined();

    const failed = updates.find((call) => call.patch.status === 'FAILED');
    expect(failed?.patch.errorMessage).toMatch(/خطای موقت/);
  });

  it('never leaks internal error details into the stored failure message', async () => {
    const { processor, extraction, updates } = setup();
    extraction.extract.mockRejectedValue(new Error('stack trace: at /usr/src/app/secret.ts:42'));

    await processor.processFile(makeJob(2, 3));

    const failed = updates.find((call) => call.patch.status === 'FAILED');
    expect(String(failed?.patch.errorMessage)).not.toContain('secret.ts');
  });

  it('treats an unsupported stored MIME type as a permanent failure', async () => {
    const { processor, storage, updates } = setup({
      file: makeFile({ mimeType: 'text/plain' }),
    });

    await processor.processFile(makeJob());

    expect(storage.getBuffer).not.toHaveBeenCalled();
    expect(updates.find((call) => call.patch.status === 'FAILED')).toBeTruthy();
  });

  it('bounds processing with a timeout (transient, so a retry may succeed)', async () => {
    const slow = setup({});
    slow.extraction.extract.mockImplementation(() => new Promise(() => undefined));
    // Rebuild with a tiny timeout to keep the test quick.
    const processorWithTinyTimeout = new FileProcessingService(
      slow.repository as unknown as Repository<File>,
      slow.storage as unknown as FileStorageService,
      slow.extraction as unknown as FileExtractionService,
      slow.queue,
      { get: () => 20 } as unknown as ConfigService,
    );

    await expect(processorWithTinyTimeout.processFile(makeJob(0, 3))).rejects.toThrow(
      /بیش از حد طول کشید/,
    );
  });
});

describe('FileProcessingService — orphan sweeper', () => {
  it('re-enqueues stale rows and fails rows with exhausted attempts', async () => {
    const { processor, repository, queue, updates } = setup({ file: null });
    repository.find.mockResolvedValue([
      makeFile({ id: 'stale-upload', status: 'UPLOADING', attempts: 0 }),
      makeFile({ id: 'stale-processing', status: 'PROCESSING', attempts: 1 }),
      makeFile({ id: 'exhausted', status: 'PROCESSING', attempts: 3 }),
    ]);

    const recovered = await processor.sweepOrphans();

    expect(recovered).toBe(3);
    expect(queue.enqueueProcessing).toHaveBeenCalledWith('stale-upload');
    expect(queue.enqueueProcessing).toHaveBeenCalledWith('stale-processing');
    expect(queue.enqueueProcessing).not.toHaveBeenCalledWith('exhausted');
    const failed = updates.find((call) => call.patch.status === 'FAILED');
    expect(failed?.patch.errorMessage).toMatch(/ناموفق/);
  });

  it('never throws when Redis is unavailable during a sweep', async () => {
    const { processor, repository, queue } = setup({ file: null });
    repository.find.mockRejectedValue(new Error('redis down'));

    await expect(processor.sweepOrphans()).resolves.toBe(0);
    expect(queue.enqueueProcessing).not.toHaveBeenCalled();
  });
});
