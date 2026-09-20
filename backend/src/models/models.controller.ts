import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ModelsService } from './models.service';
import { EntitlementsService } from '../billing/entitlements.service';

/**
 * Active models for the chat UI. Requires login; no admin role needed.
 * The list is filtered by the caller's FRESH entitlements tier (day-7-8
 * contract §16: the backend is the source of truth — a free caller sees
 * only `isFree` models, a premium caller sees every active model). This is
 * display filtering only; `resolveChatModel` re-checks access on every send
 * (INV-4).
 */
@Controller('models')
export class ModelsController {
  constructor(
    private readonly modelsService: ModelsService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  @Get()
  async listAvailable(@CurrentUser() user: { id: string }) {
    const { tier } = await this.entitlementsService.resolveForUser(user.id);
    return this.modelsService.listAvailable(tier);
  }
}
