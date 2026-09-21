import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ConversationsService } from '../conversations/conversations.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FilesService } from './files.service';
import { contentDisposition } from './content-disposition';
import { decodeUploadFilename } from './upload-filename';

/**
 * Types the browser can render inline. Everything else (Excel) is served as a
 * download, because a spreadsheet is not something a tab can display.
 */
const INLINE_PREVIEW_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg']);

/**
 * File endpoints. Both routes that carry a conversation id re-check
 * ownership server-side (same 404 convention as the rest of the API), so a
 * forged conversation/file id can never reach another user's data.
 *
 *   POST /conversations/:conversationId/files   multipart upload (fast path)
 *   GET  /conversations/:conversationId/files   status list for the chat UI
 *   GET  /files/:fileId                         single status (polling)
 *   GET  /files/:fileId/content                 preview/download (owner-only)
 *   DELETE /files/:fileId                       remove a draft attachment (owner-only)
 *   POST /files/:fileId/retry                   retry a FAILED file's processing (owner-only)
 *
 * Upload stores the binary, persists metadata in UPLOADING and enqueues the
 * background job — it never extracts or OCRs synchronously.
 */
@Controller()
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly conversationsService: ConversationsService,
  ) {}

  @Post('conversations/:conversationId/files')
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(HttpStatus.CREATED)
  async upload(
    @CurrentUser() user: { id: string },
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('فایلی برای آپلود ارسال نشده است.');
    }
    // Ownership is part of the lookup: foreign conversations 404 here,
    // before any storage or database write happens.
    await this.conversationsService.getOwned(user.id, conversationId);

    return this.filesService.upload(user.id, conversationId, {
      buffer: file.buffer,
      declaredMime: file.mimetype,
      // Repaired here, at the boundary: everything downstream (storage key,
      // database row, Content-Disposition) then works with the real name.
      originalName: decodeUploadFilename(file.originalname),
    });
  }

  @Get('conversations/:conversationId/files')
  async listForConversation(
    @CurrentUser() user: { id: string },
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    await this.conversationsService.getOwned(user.id, conversationId);
    const files = await this.filesService.listForConversation(conversationId);
    return this.filesService.safeList(files);
  }

  @Get('files/:fileId')
  async getOne(
    @CurrentUser() user: { id: string },
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    // Owner-only; other users' files are 404 (no existence leak).
    return this.filesService.getOwnedSafe(user.id, fileId);
  }

  /**
   * Removes a draft attachment (a file no message references yet): the row and
   * the stored object are both gone, so a refresh cannot resurrect a chip the
   * user deliberately removed. Files attached to a sent message are rejected
   * with a 400 — history is immutable.
   */
  @Delete('files/:fileId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: { id: string },
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ): Promise<void> {
    await this.filesService.deleteOwned(user.id, fileId);
  }

  /**
   * Owner retry for a FAILED file: FAILED → PROCESSING with a fresh job and a
   * reset attempt budget, reusing the file identity (no duplicate rows). The
   * admin reprocess endpoint stays the only path for READY files.
   */
  @Post('files/:fileId/retry')
  @HttpCode(HttpStatus.OK) // an action on an existing resource, not a creation
  async retry(
    @CurrentUser() user: { id: string },
    @Param('fileId', ParseUUIDPipe) fileId: string,
  ) {
    return this.filesService.retryProcessing(user.id, fileId);
  }

  /**
   * Streams the stored object back to its owner so the UI can show a thumbnail
   * or preview and offer a download. The raw `@Res()` is used because the body
   * is a binary stream, not JSON — ownership and existence are resolved BEFORE
   * any header is written, so failures are still normal JSON errors.
   *
   * `?download=1` forces an attachment; non-previewable types always get one.
   * MinIO stays private: the browser never receives a storage URL or key.
   */
  @Get('files/:fileId/content')
  async content(
    @CurrentUser() user: { id: string },
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Query('download') download: string | undefined,
    @Res() res: Response,
  ) {
    const { file, stream } = await this.filesService.getContent(user.id, fileId);

    const asAttachment = download === '1' || !INLINE_PREVIEW_MIMES.has(file.mimeType);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', contentDisposition(asAttachment ? 'attachment' : 'inline', file.originalName));
    // The stored MIME is from the validated allowlist, but never let a browser
    // second-guess it into executing something.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');

    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
}
