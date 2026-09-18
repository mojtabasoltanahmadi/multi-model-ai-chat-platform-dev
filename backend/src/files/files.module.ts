import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationsModule } from '../conversations/conversations.module';
import { File } from './file.entity';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';
import { AdminFilesController } from './admin-files.controller';
import { FileQueueModule } from './file-queue.module';
import { FILE_JOB_QUEUE } from './file-queue.port';
import { FileQueueService } from './file-queue.service';
import { FileStorageService } from './file-storage.service';
import { FileExtractionService } from './file-extraction.service';
import { FileProcessingService } from './file-processing.service';
import { FileProcessor } from './file-processor.consumer';

/**
 * File upload + asynchronous processing (Day 5-6).
 *
 * The module owns the whole feature: metadata (File), object storage
 * (MinIO), the BullMQ queue, the background processor and the HTTP surface.
 * Chat integration consumes only `FilesService` (READY files as context), so
 * the messages module never touches storage or the queue directly.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([File]),
    ConversationsModule,
    FileQueueModule,
    // Per-file size cap enforced by multer before the buffer is accepted;
    // the service re-checks it so the rule also holds for non-HTTP callers.
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        limits: {
          fileSize: configService.get<number>('files.maxFileSizeBytes') ?? 10 * 1024 * 1024,
          files: 1,
        },
      }),
    }),
  ],
  controllers: [FilesController, AdminFilesController],
  providers: [
    FilesService,
    FileStorageService,
    FileExtractionService,
    FileProcessingService,
    FileProcessor,
    // Consumers depend on the queue PORT; the BullMQ adapter is the binding.
    { provide: FILE_JOB_QUEUE, useExisting: FileQueueService },
  ],
  exports: [FilesService, FileStorageService, FileProcessingService],
})
export class FilesModule {}
