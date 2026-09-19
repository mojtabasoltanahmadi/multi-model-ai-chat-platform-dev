import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { QuotaService } from './quota.service';
import { EntitlementsService } from '../billing/entitlements.service';

/**
 * Quota/usage snapshot for the signed-in user (day-7-8 contract §16).
 * Admins get quota: null — they bypass quotas, so no remaining value exists.
 *
 * Since day 9-10 the limits come from the caller's subscription plan
 * (EntitlementsService — INV-05: derived server-side from the current
 * subscription + plan rows, never from client state); users without an
 * active subscription keep the env-configured free-tier limits.
 */
@Controller('usage')
export class UsageController {
  constructor(
    private readonly quotaService: QuotaService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  @Get('me')
  async me(@CurrentUser() user: { id: string; role: string }) {
    const entitlements = await this.entitlementsService.resolveForUser(user.id);
    if (user.role === 'admin') {
      return { plan: entitlements.tier, quota: null, today: { used: 0, remaining: 0, tokens: 0 } };
    }
    const snapshot = await this.quotaService.snapshotFor(
      user.id,
      entitlements.tier,
      entitlements.quota,
    );
    return {
      plan: entitlements.tier,
      quota: {
        dailyMessages: entitlements.quota.dailyMessages,
        dailyTokens: entitlements.quota.dailyTokens,
      },
      today: {
        used: snapshot.used,
        remaining: snapshot.remaining,
        tokens: snapshot.tokens,
      },
    };
  }
}
