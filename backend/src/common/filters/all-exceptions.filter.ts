import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * Last-resort filter: guarantees every unhandled error becomes a clean JSON
 * response (never a stack trace or provider detail) so the backend cannot
 * crash a request without an understandable client-facing error.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // Multer aborts oversized uploads (413) before any handler runs, so the
      // message is mapped here to stay consistent with the API's Persian
      // error convention.
      if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
        response.status(status).json({
          statusCode: status,
          message: 'حجم فایل بیش از حد مجاز است.',
        });
        return;
      }
      response.status(status).json(
        typeof body === 'string' ? { message: body } : body,
      );
      return;
    }

    this.logger.error(
      'Unhandled exception',
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره تلاش کنید.',
    });
  }
}
