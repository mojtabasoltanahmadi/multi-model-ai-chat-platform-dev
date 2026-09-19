import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UsersService } from '../users/users.service';
import { QuotaService } from './quota.service';

/**
 * Quota/usage snapshot for the signed-in user (day-7-8 contract §16).
 * Admins get quota: null — they bypass quotas, so no remaining value exists.
 */
@Controller('usage')
export class UsageController {
  constructor(
    private readonly quotaService: QuotaService,
    private readonly usersService: UsersService,
  ) {}

  @Get('me')
  async me(@CurrentUser() user: { id: string; role: string }) {
    const plan = await this.usersService.getPlan(user.id);
    if (user.role === 'admin') {
      return { plan, quota: null, today: { used: 0, remaining: 0, tokens: 0 } };
    }
    const quota = this.quotaService.quotaFor(plan);
    const snapshot = await this.quotaService.snapshotFor(user.id, plan);
    return {
      plan,
      quota: { dailyMessages: quota.dailyMessages, dailyTokens: quota.dailyTokens },
      today: {
        used: snapshot.used,
        remaining: snapshot.remaining,
        tokens: snapshot.tokens,
      },
    };
  }
}
