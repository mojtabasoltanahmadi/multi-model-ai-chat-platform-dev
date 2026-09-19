import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserPlan } from '../users/user.entity';
import { PlanQuota, UsageRecord } from './usage-record.entity';

const QUOTA_EXHAUSTED_MESSAGE = 'سهمیه پیام‌های امروز شما تمام شده است. لطفاً فردا دوباره تلاش کنید.';
const TOKEN_QUOTA_EXHAUSTED_MESSAGE =
  'سهمیه توکن‌های امروز شما تمام شده است. لطفاً فردا دوباره تلاش کنید.';

export interface QuotaSnapshot {
  used: number;
  remaining: number;
  tokens: number;
}

/**
 * Pre-stream quota gate (day-7-8 contract §7): daily message quota per plan,
 * plus an optional daily token cap. Runs BEFORE the SSE headers are flushed
 * so an exhausted user gets a clean 429 JSON, never an opened stream.
 *
 * Counting rules:
 *  - rows with outcome='failed' are EXCLUDED — a failed request must not
 *    consume quota (its tokens still count for cost accounting); the retry
 *    of a failed turn reuses the same usage row, so it is charged at most once.
 *  - 'pending' rows count: an in-flight accepted turn consumes its slot.
 *  - admins bypass entirely.
 *
 * Concurrency: no locks. Two simultaneous sends can both pass this check —
 * the day's limit may be exceeded by the race width (documented §7.6). The
 * unique message_id on usage_records is the hard guarantee that no turn is
 * ever recorded twice.
 */
@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    @InjectRepository(UsageRecord)
    private readonly usageRepository: Repository<UsageRecord>,
    private readonly configService: ConfigService,
  ) {}

  /** Limits for the plan; null dailyTokens means the token cap is disabled. */
  quotaFor(plan: UserPlan): PlanQuota {
    return plan === 'premium'
      ? {
          dailyMessages:
            this.configService.get<number>('quota.premiumDailyMessages') ?? 500,
          dailyTokens:
            this.configService.get<number | null>('quota.premiumDailyTokens') ?? null,
        }
      : {
          dailyMessages: this.configService.get<number>('quota.freeDailyMessages') ?? 50,
          dailyTokens: this.configService.get<number | null>('quota.freeDailyTokens') ?? null,
        };
  }

  /**
   * Throws 429 when the plan's daily message or token quota is exhausted.
   * Consumed = today's usage rows for the user whose outcome is NOT 'failed'
   * (see class doc).
   */
  async assertQuota(userId: string, plan: UserPlan): Promise<void> {
    const snapshot = await this.snapshotFor(userId, plan);
    if (snapshot.remaining <= 0) {
      this.logger.log(`QuotaRejected userId=${userId} used=${snapshot.used} limit=messages`);
      throw new HttpException(QUOTA_EXHAUSTED_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
    }
    const { dailyTokens } = this.quotaFor(plan);
    if (dailyTokens !== null && snapshot.tokens >= dailyTokens) {
      this.logger.log(
        `QuotaRejected userId=${userId} tokens=${snapshot.tokens} limit=tokens`,
      );
      throw new HttpException(TOKEN_QUOTA_EXHAUSTED_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /** Today's consumption for the quota UI (GET /usage/me). */
  async snapshotFor(userId: string, plan: UserPlan): Promise<QuotaSnapshot> {
    const { dailyMessages } = this.quotaFor(plan);
    // QueryBuilder takes ENTITY property names (camelCase) — it maps them to
    // the quoted snake_case columns itself.
    const row = await this.usageRepository
      .createQueryBuilder('usage')
      .select('COUNT(*)', 'turns')
      .addSelect("COALESCE(SUM(COALESCE(usage.inputTokens, 0) + COALESCE(usage.outputTokens, 0)), 0)", 'tokens')
      .where('usage.userId = :userId', { userId })
      .andWhere('usage.createdAt >= :startOfDay', { startOfDay: startOfUtcDay() })
      .andWhere('usage.outcome != :failed', { failed: 'failed' })
      .getRawOne();

    const used = parseInt(row?.turns ?? '0', 10) || 0;
    const tokens = parseInt(row?.tokens ?? '0', 10) || 0;
    return {
      used,
      remaining: Math.max(0, dailyMessages - used),
      tokens,
    };
  }
}

/** The quota window is the current UTC day — deterministic across clients. */
export function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
