import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FILE_PROCESSING_QUEUE } from './file-queue.port';
import { FileQueueService } from './file-queue.service';

/**
 * Registers the file-processing queue. The Redis connection is read from
 * configuration so deployments can point elsewhere without touching code.
 */
@Module({
  imports: [
    BullModule.registerQueueAsync({
      name: FILE_PROCESSING_QUEUE,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('queue.redisHost') ?? 'localhost',
          port: configService.get<number>('queue.redisPort') ?? 6379,
          // Queue state is disposable job metadata; a lost queue is recovered
          // by the orphan sweeper, not by Redis persistence.
          maxRetriesPerRequest: null,
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 3_000 },
        },
      }),
    }),
  ],
  providers: [FileQueueService],
  exports: [FileQueueService, BullModule],
})
export class FileQueueModule {}
