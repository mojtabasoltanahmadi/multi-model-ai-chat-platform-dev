import { EntitlementsService } from './entitlements.service';
import { SubscriptionsService } from './subscriptions.service';
import { Plan } from './plan.entity';
import { Subscription } from './subscription.entity';

const planRow = (overrides: Partial<Plan> = {}): Plan =>
  ({
    id: 'plan-1',
    slug: 'pro',
    name: 'Pro',
    description: null,
    price: '200000',
    currency: 'IRT',
    billingPeriod: 'monthly',
    dailyMessageQuota: 500,
    dailyTokenQuota: 600000,
    allowedModelIds: ['model-a'],
    webSearch: true,
    thinking: true,
    fileProcessing: false,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Plan;

const activeSubscription = (overrides: Partial<Subscription> = {}): Subscription =>
  ({
    id: 'sub-1',
    userId: 'user-1',
    planId: 'plan-1',
    planSlug: 'pro',
    planName: 'Pro',
    status: 'active',
    currentPeriodStart: new Date(Date.now() - 24 * 3600 * 1000),
    currentPeriodEnd: new Date(Date.now() + 24 * 3600 * 1000),
    sourcePaymentId: 'pay-1',
    cancelledAt: null,
    createdAt: new Date(),
    ...overrides,
  }) as Subscription;

describe('EntitlementsService — access policy (INV-05 / INV-06)', () => {
  let plansRepository: { findOne: jest.Mock };
  let subscriptionsService: { getActiveOrExpire: jest.Mock };
  let configService: { get: jest.Mock };
  let service: EntitlementsService;
  let currentSubscription: Subscription;

  beforeEach(() => {
    plansRepository = { findOne: jest.fn(async () => planRow()) };
    currentSubscription = activeSubscription();
    subscriptionsService = { getActiveOrExpire: jest.fn(async () => currentSubscription) };
    configService = { get: jest.fn((key: string) => (key === 'quota.freeDailyMessages' ? 50 : undefined)) };
    service = new EntitlementsService(
      plansRepository as never,
      subscriptionsService as never,
      configService as never,
    );
  });

  it('a subscriber gets the plan’s quotas, features and model allowlist — resolved fresh', async () => {
    const snapshot = await service.resolveForUser('user-1');

    expect(snapshot.tier).toBe('premium');
    expect(snapshot.planSlug).toBe('pro');
    expect(snapshot.quota).toEqual({ dailyMessages: 500, dailyTokens: 600000 });
    expect(snapshot.features).toEqual({ webSearch: true, thinking: true, fileProcessing: false });
    expect(snapshot.allowedModelIds).toEqual(['model-a']);
    expect(snapshot.currentPeriodEnd).toBe(currentSubscription.currentPeriodEnd.toISOString());
  });

  it('a user without a subscription gets the env-configured free tier', async () => {
    subscriptionsService.getActiveOrExpire = jest.fn(async () => null);

    const snapshot = await service.resolveForUser('user-1');

    expect(snapshot.tier).toBe('free');
    expect(snapshot.quota.dailyMessages).toBe(50);
    expect(snapshot.quota.dailyTokens).toBeNull();
    // Free tier preserves pre-billing behavior for features and model rules.
    expect(snapshot.features).toEqual({ webSearch: true, thinking: true, fileProcessing: true });
    expect(snapshot.allowedModelIds).toBeNull();
  });

  it('an EXPIRED period is treated as no subscription (INV-06: expired entitlements rejected)', async () => {
    // getActiveOrExpire is the lazy-expiration trigger; it returns null once
    // the period ended — the snapshot must then be the free tier.
    subscriptionsService.getActiveOrExpire = jest.fn(async () => null);

    const snapshot = await service.resolveForUser('user-1');

    expect(snapshot.tier).toBe('free');
    expect(snapshot.subscriptionId).toBeNull();
  });

  it('a deactivated plan with a still-active subscription KEEPS its entitlements (documented deactivation policy)', async () => {
    plansRepository.findOne = jest.fn(async () => planRow({ isActive: false }));

    const snapshot = await service.resolveForUser('user-1');

    expect(snapshot.tier).toBe('premium');
    expect(snapshot.features.webSearch).toBe(true);
  });

  it('a missing plan row falls back to the free tier instead of granting everything', async () => {
    plansRepository.findOne = jest.fn(async () => null);

    const snapshot = await service.resolveForUser('user-1');

    expect(snapshot.tier).toBe('free');
  });
});
