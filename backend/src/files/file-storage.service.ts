import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client as MinioClient } from 'minio';
import type { Readable } from 'node:stream';

/**
 * Object storage facade over MinIO. One small service so the rest of the
 * codebase never touches the MinIO SDK directly. The bucket is created
 * idempotently at startup (MVP convenience; in production this belongs to
 * deployment/terraform).
 */
@Injectable()
export class FileStorageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FileStorageService.name);
  private readonly client: MinioClient;
  private readonly bucket: string;

  constructor(configService: ConfigService) {
    this.bucket = configService.get<string>('storage.bucket') ?? 'chat-files';
    this.client = new MinioClient({
      endPoint: configService.get<string>('storage.endpoint') ?? 'localhost',
      port: configService.get<number>('storage.port') ?? 9000,
      useSSL: configService.get<boolean>('storage.useSsl') ?? false,
      accessKey: configService.get<string>('storage.accessKey') ?? 'minioadmin',
      secretKey: configService.get<string>('storage.secretKey') ?? 'minioadmin',
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket);
        this.logger.log(`Created storage bucket "${this.bucket}".`);
      }
    } catch (error) {
      // Startup tolerates a temporarily unavailable MinIO: uploads will fail
      // with a clear storage error until it returns, but the API can still
      // serve chat. The sweeper/retries recover orphaned rows afterwards.
      this.logger.error(
        `Storage unavailable at startup (${error instanceof Error ? error.message : String(error)}). Uploads will fail until it is reachable.`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    // minio v8 keeps no persistent sockets that need explicit teardown.
  }

  /** Server-generated key: files/{userId}/{conversationId}/{uuid}.<ext> */
  buildStorageKey(userId: string, conversationId: string, extension: string): string {
    const safeExt = extension.replace(/[^a-z0-9]/gi, '').slice(0, 10);
    const uuid = crypto.randomUUID();
    return `files/${userId}/${conversationId}/${uuid}${safeExt ? `.${safeExt}` : ''}`;
  }

  async putBuffer(key: string, buffer: Buffer, mimeType: string): Promise<void> {
    await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': mimeType,
    });
  }

  async getBuffer(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.getStream(key)) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /**
   * Pipes an object without buffering it in memory. Used by the owner-only
   * content endpoint; a missing object rejects, and the caller must not have
   * flushed any response yet.
   */
  async getStream(key: string): Promise<Readable> {
    return this.client.getObject(this.bucket, key);
  }

  async remove(key: string): Promise<void> {
    try {
      await this.client.removeObject(this.bucket, key);
    } catch (error) {
      // Deletion failure must not break the DB delete flow; log and continue.
      this.logger.warn(
        `Failed to remove object ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      return await this.client.bucketExists(this.bucket);
    } catch {
      return false;
    }
  }
}
