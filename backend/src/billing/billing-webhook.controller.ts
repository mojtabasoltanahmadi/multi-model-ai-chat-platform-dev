import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { WebhookService, IncomingWebhookEvent, WebhookProcessingResult } from './webhook.service';
import { WEBHOOK_SIGNATURE_HEADER, verifyWebhookSignature } from './webhook-signature';

/**
 * Public gateway callback. Authenticated by the HMAC signature over the RAW
 * request body — a forged or unsigned event is rejected with 401 and never
 * touches the database. Replays are answered 200 with status 'duplicate'
 * (gateways treat non-2xx as "retry later", which a replay is not).
 */
@Public()
@Controller('billing/webhook')
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);

  constructor(
    private readonly webhookService: WebhookService,
    private readonly configService: ConfigService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() request: RawBodyRequest<Request>,
    @Headers(WEBHOOK_SIGNATURE_HEADER) signature?: string,
  ): Promise<WebhookProcessingResult & { received: true }> {
    const rawBody = request.rawBody;
    if (!rawBody) {
      throw new BadRequestException('بدنه درخواست معتبر نیست.');
    }
    const secret = this.configService.get<string>('billing.webhookSecret') ?? '';
    if (!verifyWebhookSignature(rawBody, signature, secret)) {
      this.logger.warn(`WebhookRejected reason=invalid-signature ip=${request.ip ?? '-'}`);
      throw new UnauthorizedException('امضای وب‌هوک معتبر نیست.');
    }

    let parsed: { eventId?: unknown; eventType?: unknown; payload?: unknown };
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('بدنه وب‌هوک JSON معتبر نیست.');
    }
    if (
      typeof parsed.eventId !== 'string' ||
      parsed.eventId.length === 0 ||
      typeof parsed.eventType !== 'string' ||
      parsed.eventType.length === 0 ||
      typeof parsed.payload !== 'object' ||
      parsed.payload === null
    ) {
      throw new BadRequestException('ساختار رویداد وب‌هوک معتبر نیست.');
    }

    const event: IncomingWebhookEvent = {
      eventId: parsed.eventId,
      eventType: parsed.eventType,
      payload: parsed.payload as Record<string, unknown>,
      provider: 'simulator',
    };
    const result = await this.webhookService.processEvent(event);
    return { received: true, ...result };
  }
}
