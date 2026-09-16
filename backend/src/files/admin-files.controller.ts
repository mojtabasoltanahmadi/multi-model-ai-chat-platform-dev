import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FilesService } from './files.service';
import { FILE_JOB_QUEUE, FileJobQueue } from './file-queue.port';
import { FileStatus } from './file.entity';

const STATUSES: FileStatus[] = ['UPLOADING', 'PROCESSING', 'READY', 'FAILED'];

/**
 * Admin-only global file processing view (Section 27/28). Route protection is
 * enforced here in the backend by @Roles('admin') + the global RolesGuard —
 * the frontend route guard is convenience, never the authorization.
 *
 * Returned data never includes extracted text or stack traces: failed rows
 * carry the same safe reason the user sees, plus owner/conversation context
 * so admins can tell which upload to investigate.
 */
@Roles('admin')
@Controller('admin/files')
export class AdminFilesController {
  constructor(
    private readonly filesService: FilesService,
    @Inject(FILE_JOB_QUEUE) private readonly queueService: FileJobQueue,
  ) {}

  @Get()
  async list(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const parsedStatus = status ? (status.toUpperCase() as FileStatus) : undefined;
    if (parsedStatus && !STATUSES.includes(parsedStatus)) {
      throw new BadRequestException('وضعیت فایل نامعتبر است.');
    }
    const take = clampInt(limit, 50, 1, 200);
    const skip = clampInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const [{ items, total }, counts] = await Promise.all([
      this.filesService.listForAdmin({ status: parsedStatus, limit: take, offset: skip }),
      this.filesService.countByStatus(),
    ]);

    return {
      total,
      counts,
      items: items.map((file) => ({
        id: file.id,
        originalName: file.originalName,
        mimeType: file.mimeType,
        size: file.size,
        status: file.status,
        errorMessage: file.errorMessage,
        attempts: file.attempts,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        userId: file.userId,
        userEmail: file.user?.email ?? null,
        conversationId: file.conversationId,
        conversationTitle: file.conversation?.title ?? null,
      })),
    };
  }

  /** Operational snapshot: row counts by status + live queue depth. */
  @Get('stats')
  async stats() {
    const [counts, queue] = await Promise.all([
      this.filesService.countByStatus(),
      this.queueService.getJobCounts().catch(() => null),
    ]);
    return { counts, queue };
  }

  /**
   * Explicit reprocess (Section 8): the ONLY path that may move a READY or
   * FAILED file back to PROCESSING. Also used to recover rows left behind by
   * a failed enqueue or a worker crash.
   */
  @Post(':fileId/reprocess')
  async reprocess(
    @CurrentUser() admin: { id: string },
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    return this.filesService.reprocess(admin.id, fileId);
  }
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw === undefined ? NaN : parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
