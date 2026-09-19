import { QuotaService, startOfUtcDay } from './quota.service';
import { ForbiddenException } from '@nestjs/common';

/** Minimal chainable QueryBuilder mock exposing only getRawOne. */
function qbMock(rawOne: Record<string, unknown> | undefined) {
  const qb: any = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'addGroupBy',
    'orderBy',
    'leftJoin',
    'innerJoin',
  ]) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawOne = jest.fn().mockResolvedValue(rawOne);
  return qb;
}

const service = (rawOne: Record<string, unknown> | undefined, quota: Record<string, unknown>) => {
  const qb = qbMock(rawOne);
  const repository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  const configService = { get: (key: string) => quota[key] };
  return {
    service: new QuotaService(repository as any, configService as any),
    qb,
  };
};

describe('QuotaService', () => {
  it('admits a user below the daily message limit', async () => {
    const { service: svc } = service({ turns: '3', tokens: '100' }, { 'quota.freeDailyMessages': 50 });
    await expect(svc.assertQuota('user-1', 'free')).resolves.toBeUndefined();
  });

  it('rejects with 429 when the daily message limit is reached', async () => {
    const { service: svc } = service({ turns: '50', tokens: '100' }, { 'quota.freeDailyMessages': 50 });
    await expect(svc.assertQuota('user-1', 'free')).rejects.toMatchObject({
      status: 429,
      message: QUOTA_MESSAGE,
    });
  });

  it('rejects with 429 when the configured daily token limit is reached', async () => {
    const { service: svc } = service(
      { turns: '2', tokens: '60000' },
      { 'quota.freeDailyMessages': 50, 'quota.freeDailyTokens': 50000 },
    );
    await expect(svc.assertQuota('user-1', 'free')).rejects.toMatchObject({
      status: 429,
      message: TOKEN_QUOTA_MESSAGE,
    });
  });

  it('ignores the token check when no token limit is configured', async () => {
    const { service: svc } = service({ turns: '2', tokens: '999999' }, { 'quota.freeDailyMessages': 50 });
    await expect(svc.assertQuota('user-1', 'free')).resolves.toBeUndefined();
  });

  it('uses the premium plan limits', async () => {
    const { service: svc, qb } = service({ turns: '400', tokens: '0' }, {
      'quota.freeDailyMessages': 50,
      'quota.premiumDailyMessages': 500,
    });
    await expect(svc.assertQuota('user-1', 'premium')).resolves.toBeUndefined();
    // the COUNT ran against the user + day window + outcome filter
    // (QueryBuilder takes entity property names and maps them to the
    // quoted snake_case columns itself — see QuotaService.snapshotFor).
    expect(qb.where).toHaveBeenCalledWith('usage.userId = :userId', { userId: 'user-1' });
  });

  it('snapshotFor reports used/remaining/tokens with failed turns excluded', async () => {
    const { service: svc, qb } = service({ turns: '7', tokens: '1234' }, { 'quota.freeDailyMessages': 50 });
    const snapshot = await svc.snapshotFor('user-1', 'free');
    expect(snapshot).toEqual({ used: 7, remaining: 43, tokens: 1234 });
    // failed turns are filtered out of the quota count
    expect(qb.andWhere).toHaveBeenCalledWith('usage.outcome != :failed', { failed: 'failed' });
    // and the window starts at UTC midnight
    expect(qb.andWhere).toHaveBeenCalledWith('usage.createdAt >= :startOfDay', {
      startOfDay: startOfUtcDay(),
    });
  });

  it('treats missing aggregates as zero', async () => {
    const { service: svc } = service(undefined, { 'quota.freeDailyMessages': 50 });
    const snapshot = await svc.snapshotFor('user-1', 'free');
    expect(snapshot).toEqual({ used: 0, remaining: 50, tokens: 0 });
  });
});

const QUOTA_MESSAGE = 'سهمیه پیام‌های امروز شما تمام شده است. لطفاً فردا دوباره تلاش کنید.';
const TOKEN_QUOTA_MESSAGE =
  'سهمیه توکن‌های امروز شما تمام شده است. لطفاً فردا دوباره تلاش کنید.';
