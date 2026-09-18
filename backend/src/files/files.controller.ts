import {
  BadRequestException,
  Controller,
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
