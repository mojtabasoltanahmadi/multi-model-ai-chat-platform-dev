import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConversationsService } from '../conversations/conversations.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FilesService } from './files.service';

/**
 * File endpoints. Both routes that carry a conversation id re-check
 * ownership server-side (same 404 convention as the rest of the API), so a
 * forged conversation/file id can never reach another user's data.
 *
 *   POST /conversations/:conversationId/files   multipart upload (fast path)
 *   GET  /conversations/:conversationId/files   status list for the chat UI
 *   GET  /files/:fileId                         single status (polling)
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
      originalName: file.originalname,
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
}
