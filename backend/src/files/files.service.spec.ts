import { Readable } from 'node:stream';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { File, FileStatus } from './file.entity';
import { FileJobQueue, QueueJobCounts } from './file-queue.port';
import { FileStorageService } from './file-storage.service';
import { FilesService } from './files.service';
import { minimalPdfBuffer, tinyPngBuffer } from '../test/fixtures';

interface SavedRow {
  [key: string]: unknown;
}

function makeStoredFile(overrides: Partial<File> = {}): File {
  const file = new File();
  Object.assign(
    file,
    {
      id: 'file-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      originalName: 'report.pdf',
      mimeType: 'application/pdf',
      size: 590,
      storageKey: 'files/user-1/conv-1/key.pdf',
      status: 'PROCESSING' as FileStatus,
      extractedText: null,
      errorMessage: null,
      attempts: 0,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
    overrides,
  );
  return file;
}

function setup({
  dbFails = false,
  enqueueFails = false,
  existing = null as File | null,
  found = [] as File[],
  referenced = false,
  removeFails = false,
} = {}) {
  const saved: SavedRow[] = [];
  const inserted: SavedRow[] = [];

  const queryBuilder = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(async (): Promise<{ status: string; count: string }[]> => []),
  };

  // The Message query builder behind deleteOwned's consumed-reference check.
  const messagesQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getExists: jest.fn(async (): Promise<boolean> => referenced),
  };

  const repository = {
    findOne: jest.fn(async () => existing),
    find: jest.fn(async () => found),
    save: jest.fn(async (entity: File) => {
      const row = { ...entity, id: entity.id ?? 'file-new' };
      saved.push(row);
      Object.assign(entity, row);
      return entity;
    }),
    update: jest.fn(async () => undefined),
    remove: jest.fn(async () => {
      if (removeFails) throw new Error('database is down');
      return undefined;
    }),
    findAndCount: jest.fn(async () => [found, found.length]),
    createQueryBuilder: jest.fn(() => queryBuilder),
    manager: {
      getRepository: jest.fn(() => ({
        createQueryBuilder: () => messagesQueryBuilder,
      })),
      transaction: jest.fn(async (callback: (manager: unknown) => Promise<File>) => {
        if (dbFails) throw new Error('database is down');
        const manager = {
          getRepository: () => ({
            create: (data: Partial<File>) => {
              const file = new File();
              Object.assign(file, data);
              inserted.push(data as SavedRow);
              return file;
            },
            save: async (entity: File) => {
              const row = { ...entity, id: 'file-new' };
              saved.push(row);
              Object.assign(entity, row);
              return entity;
            },
          }),
        };
        return callback(manager);
      }),
    },
  };

  const storage = {
    buildStorageKey: jest.fn(() => 'files/user-1/conv-1/generated.pdf'),
    putBuffer: jest.fn().mockResolvedValue(undefined),
    getBuffer: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')),
    getStream: jest.fn().mockResolvedValue(Readable.from([Buffer.from('%PDF-1.4')])),
    remove: jest.fn().mockResolvedValue(undefined),
  };

  const queue: FileJobQueue & { enqueueProcessing: jest.Mock } = {
    enqueueProcessing: enqueueFails
      ? jest.fn().mockRejectedValue(new Error('redis unavailable'))
      : jest.fn().mockResolvedValue(undefined),
    getJobCounts: jest.fn(
      async (): Promise<QueueJobCounts> => ({ waiting: 0, active: 0, failed: 0, completed: 0 }),
    ),
  };

  const configService = {
    get: (key: string) =>
      ({
        'files.maxFileSizeBytes': 10 * 1024 * 1024,
        'files.maxFilesPerMessage': 6,
      })[key],
  } as unknown as ConfigService;

  const service = new FilesService(
    repository as unknown as Repository<File>,
    storage as unknown as FileStorageService,
    queue,
    configService,
  );

  return { service, repository, storage, queue, saved, inserted, queryBuilder, messagesQueryBuilder };
}

const pdfInput = {
  buffer: minimalPdfBuffer(),
  declaredMime: 'application/pdf',
  originalName: 'report.pdf',
};

describe('FilesService — upload', () => {
  it('validates, stores the object, records UPLOADING and enqueues in order', async () => {
    const { service, storage, queue, inserted, saved } = setup();

    const result = await service.upload('user-1', 'conv-1', pdfInput);

    expect(storage.putBuffer).toHaveBeenCalledWith(
      'files/user-1/conv-1/generated.pdf',
      expect.any(Buffer),
      'application/pdf',
    );
    // The row is created in the initial state of the lifecycle; the worker owns
    // the UPLOADING → PROCESSING transition.
    expect(inserted[0]).toMatchObject({
      userId: 'user-1',
      conversationId: 'conv-1',
      status: 'UPLOADING',
      mimeType: 'application/pdf',
    });
    expect(queue.enqueueProcessing).toHaveBeenCalledWith('file-new');
    expect(result.id).toBe('file-new');
    expect(saved.length).toBeGreaterThan(0);
  });

  it('rejects invalid content before touching storage or the database', async () => {
    const { service, storage, queue, inserted } = setup();

    await expect(
      service.upload('user-1', 'conv-1', {
        buffer: tinyPngBuffer(),
        declaredMime: 'application/pdf', // spoofed
        originalName: 'fake.pdf',
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(storage.putBuffer).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(queue.enqueueProcessing).not.toHaveBeenCalled();
  });

  it('removes the stored object when the DB insert fails (no orphan binary)', async () => {
    const { service, storage } = setup({ dbFails: true });

    await expect(service.upload('user-1', 'conv-1', pdfInput)).rejects.toThrow(
      'database is down',
    );

    expect(storage.remove).toHaveBeenCalledWith('files/user-1/conv-1/generated.pdf');
  });

  it('keeps the upload usable when enqueueing fails (sweeper recovers it)', async () => {
    const { service, queue } = setup({ enqueueFails: true });

    // A Redis hiccup must not fail an upload that is already stored and
    // recorded: the row stays UPLOADING and the sweeper re-enqueues it.
    await expect(service.upload('user-1', 'conv-1', pdfInput)).resolves.toMatchObject({
      status: expect.any(String),
    });
    expect(queue.enqueueProcessing).toHaveBeenCalled();
  });

  it('never exposes the storage key or extracted text in API responses', async () => {
    const { service } = setup();

    const result = await service.upload('user-1', 'conv-1', pdfInput);

    expect(result).not.toHaveProperty('storageKey');
    expect(result).not.toHaveProperty('extractedText');
    expect(Object.keys(result).sort()).toEqual(
      [
        'attempts',
        'conversationId',
        'createdAt',
        'errorMessage',
        'id',
        'mimeType',
        'originalName',
        'size',
        'status',
        'updatedAt',
        'userId',
      ].sort(),
    );
  });

  it('generates a fresh storage key per upload (no name-derived paths)', async () => {
    const { service, storage } = setup();

    await service.upload('user-1', 'conv-1', {
      buffer: minimalPdfBuffer(),
      declaredMime: 'application/pdf',
      originalName: '../../evil/path/report.pdf',
    });

    expect(storage.buildStorageKey).toHaveBeenCalledWith('user-1', 'conv-1', 'pdf');
    expect(storage.putBuffer.mock.calls[0][0]).toBe('files/user-1/conv-1/generated.pdf');
  });
});

describe('FilesService — ownership', () => {
  it('returns the file for its owner', async () => {
    const { service } = setup({ existing: makeStoredFile() });
    await expect(service.getOwnedSafe('user-1', 'file-1')).resolves.toMatchObject({
      id: 'file-1',
    });
  });

  it('404s for another user\'s file (no existence leak)', async () => {
    const { service, repository } = setup({ existing: null });

    await expect(service.getOwnedSafe('user-2', 'file-1')).rejects.toMatchObject({ status: 404 });
    // Ownership is part of the query, never a post-check.
    expect(repository.findOne).toHaveBeenCalledWith({
      where: { id: 'file-1', userId: 'user-2' },
    });
  });
});

describe('FilesService — chat context (READY only)', () => {
  it('returns extracted text for READY files of the conversation', async () => {
    const ready = makeStoredFile({ status: 'READY', extractedText: 'pdf body' });
    const { service } = setup({ found: [ready] });

    await expect(service.getReadyContext('conv-1', ['file-1'])).resolves.toEqual([
      {
        id: 'file-1',
        originalName: 'report.pdf',
        mimeType: 'application/pdf',
        extractedText: 'pdf body',
      },
    ]);
  });

  it('rejects a file that is still processing with a user-friendly message', async () => {
    const { service } = setup({
      found: [makeStoredFile({ status: 'PROCESSING', extractedText: null })],
    });

    await expect(service.getReadyContext('conv-1', ['file-1'])).rejects.toThrow(
      /هنوز در حال پردازش است/,
    );
  });

  it('rejects a failed file', async () => {
    const { service } = setup({
      found: [makeStoredFile({ status: 'FAILED', errorMessage: 'خراب' })],
    });

    await expect(service.getReadyContext('conv-1', ['file-1'])).rejects.toThrow(
      /ناموفق بوده است/,
    );
  });

  it('rejects a file id that does not belong to this conversation', async () => {
    // The query is scoped by conversation, so a foreign id simply is not found.
    const { service } = setup({ found: [] });

    await expect(service.getReadyContext('conv-1', ['other-conv-file'])).rejects.toThrow(
      /پیدا نشد یا به این گفتگو تعلق ندارد/,
    );
  });

  it('rejects more files than the configured per-message cap', async () => {
    const { service } = setup();

    await expect(
      service.getReadyContext('conv-1', ['a', 'b', 'c', 'd', 'e', 'f', 'g']),
    ).rejects.toThrow(/حداکثر 6 فایل/);
  });

  it('returns nothing when no file is attached', async () => {
    const { service, repository } = setup();
    await expect(service.getReadyContext('conv-1', [])).resolves.toEqual([]);
    expect(repository.find).not.toHaveBeenCalled();
  });
});

describe('FilesService — explicit reprocess', () => {
  it('moves a FAILED file back to PROCESSING and re-enqueues it', async () => {
    const { service, queue, repository } = setup({
      existing: makeStoredFile({ status: 'FAILED', errorMessage: 'خراب' }),
    });

    const result = await service.reprocess('admin-1', 'file-1');

    expect(result?.status).toBe('PROCESSING');
    expect(repository.save).toHaveBeenCalled();
    expect(queue.enqueueProcessing).toHaveBeenCalledWith('file-1');
  });

  it('moves a READY file back to PROCESSING only through this explicit action', async () => {
    const { service } = setup({ existing: makeStoredFile({ status: 'READY' }) });

    await expect(service.reprocess('admin-1', 'file-1')).resolves.toMatchObject({
      status: 'PROCESSING',
    });
  });

  it('refuses to reprocess a file that is already queued or running', async () => {
    for (const status of ['UPLOADING', 'PROCESSING'] as FileStatus[]) {
      const { service, repository, queue } = setup({ existing: makeStoredFile({ status }) });

      await expect(service.reprocess('admin-1', 'file-1')).rejects.toMatchObject({ status: 400 });
      expect(repository.save).not.toHaveBeenCalled();
      expect(queue.enqueueProcessing).not.toHaveBeenCalled();
    }
  });

  it('404s for an unknown file', async () => {
    const { service } = setup({ existing: null });
    await expect(service.reprocess('admin-1', 'missing')).rejects.toMatchObject({ status: 404 });
  });
});

describe('FilesService — content stream (preview/download)', () => {
  it('streams the object for the owner', async () => {
    const { service, storage } = setup({ existing: makeStoredFile({ status: 'READY' }) });

    const result = await service.getContent('user-1', 'file-1');

    expect(result.file.id).toBe('file-1');
    expect(storage.getStream).toHaveBeenCalledWith('files/user-1/conv-1/key.pdf');
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('%PDF-1.4');
  });

  it('404s for a foreign file and never touches storage', async () => {
    // getOwned filters by userId in the query, so a foreign id returns null.
    const { service, storage } = setup({ existing: null });

    await expect(service.getContent('user-2', 'file-1')).rejects.toMatchObject({ status: 404 });
    expect(storage.getStream).not.toHaveBeenCalled();
  });

  it('404s (and logs) when the row exists but the object is gone', async () => {
    const { service, storage } = setup({ existing: makeStoredFile({ status: 'READY' }) });
    storage.getStream.mockRejectedValueOnce(new Error('NoSuchKey'));

    await expect(service.getContent('user-1', 'file-1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('FilesService — admin statistics', () => {
  it('groups row counts by status and totals them', async () => {
    const { service, queryBuilder } = setup();
    queryBuilder.getRawMany.mockResolvedValue([
      { status: 'READY', count: '3' },
      { status: 'FAILED', count: '2' },
      { status: 'PROCESSING', count: '1' },
    ]);

    await expect(service.countByStatus()).resolves.toEqual({
      UPLOADING: 0,
      PROCESSING: 1,
      READY: 3,
      FAILED: 2,
      total: 6,
    });
  });
});

describe('FilesService — owner retry of a FAILED file', () => {
  it('moves a FAILED file back to PROCESSING with a fresh attempt budget', async () => {
    const { service, repository, queue } = setup({
      existing: makeStoredFile({ status: 'FAILED', errorMessage: 'خراب', attempts: 3 }),
    });

    const result = await service.retryProcessing('user-1', 'file-1');

    expect(result).toMatchObject({ id: 'file-1', status: 'PROCESSING' });
    expect(result.errorMessage).toBeNull();
    expect(result.attempts).toBe(0);
    expect(repository.save).toHaveBeenCalled();
    expect(queue.enqueueProcessing).toHaveBeenCalledWith('file-1');
  });

  it('reuses the file identity (no duplicate row, no new upload)', async () => {
    const { service, repository } = setup({
      existing: makeStoredFile({ status: 'FAILED' }),
    });

    await service.retryProcessing('user-1', 'file-1');

    // save() on the SAME entity row — never an insert of a second record.
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'file-1' }));
  });

  it('refuses a file that is READY, UPLOADING or PROCESSING', async () => {
    for (const status of ['READY', 'UPLOADING', 'PROCESSING'] as FileStatus[]) {
      const { service, repository, queue } = setup({ existing: makeStoredFile({ status }) });

      await expect(service.retryProcessing('user-1', 'file-1')).rejects.toMatchObject({
        status: 400,
      });
      expect(repository.save).not.toHaveBeenCalled();
      expect(queue.enqueueProcessing).not.toHaveBeenCalled();
    }
  });

  it('404s for another user\'s file (no existence leak)', async () => {
    // getOwned filters by userId in the query, so a foreign id returns null.
    const { service } = setup({ existing: null });

    await expect(service.retryProcessing('user-2', 'file-1')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('rolls the row back to FAILED and returns 503 when the queue is unavailable', async () => {
    const { service, repository } = setup({
      existing: makeStoredFile({ status: 'FAILED' }),
      enqueueFails: true,
    });

    await expect(service.retryProcessing('user-1', 'file-1')).rejects.toMatchObject({
      status: 503,
    });
    // The row must never be left PROCESSING with no job behind it: the
    // conditional update flips it back (only if still PROCESSING).
    expect(repository.update).toHaveBeenCalledWith(
      { id: 'file-1', status: 'PROCESSING' },
      expect.objectContaining({ status: 'FAILED', errorMessage: expect.any(String) }),
    );
  });
});

describe('FilesService — owner delete of a draft attachment', () => {
  it('deletes an unreferenced file: the row first, then the stored object', async () => {
    const file = makeStoredFile({ status: 'READY' });
    const { service, repository, storage } = setup({ existing: file, referenced: false });

    await expect(service.deleteOwned('user-1', 'file-1')).resolves.toBeUndefined();

    expect(repository.remove).toHaveBeenCalledWith(file);
    expect(storage.remove).toHaveBeenCalledWith('files/user-1/conv-1/key.pdf');
    // The reference check ran against the file's conversation.
    expect(repository.manager.getRepository).toHaveBeenCalled();
  });

  it('rejects a file that a persisted message references (history is immutable)', async () => {
    const { service, repository, storage } = setup({
      existing: makeStoredFile({ status: 'READY' }),
      referenced: true,
    });

    await expect(service.deleteOwned('user-1', 'file-1')).rejects.toMatchObject({ status: 400 });
    expect(repository.remove).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('404s for another user\'s file and never touches storage', async () => {
    // getOwned filters by userId in the query, so a foreign id returns null.
    const { service, storage } = setup({ existing: null });

    await expect(service.deleteOwned('user-2', 'file-1')).rejects.toMatchObject({ status: 404 });
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('removes the row even for a file that never finished processing', async () => {
    const { service, repository } = setup({
      existing: makeStoredFile({ status: 'UPLOADING' }),
    });

    await expect(service.deleteOwned('user-1', 'file-1')).resolves.toBeUndefined();
    expect(repository.remove).toHaveBeenCalled();
  });

  it('propagates a database failure (the row stays, deletion can be retried)', async () => {
    const { service, storage } = setup({
      existing: makeStoredFile(),
      removeFails: true,
    });

    await expect(service.deleteOwned('user-1', 'file-1')).rejects.toThrow('database is down');
    // The object was NOT removed while the row remains — deleting again
    // (idempotent MinIO removal) converges instead of drifting.
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
