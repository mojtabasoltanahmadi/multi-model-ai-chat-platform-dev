import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plan } from './plan.entity';
import { SubscriptionsService } from './subscriptions.service';
import { PlanQuota } from '../usage/usage-record.entity';

/** Feature flags a plan can grant. Free tier keeps today's behavior (all on). */
export interface PlanFeatures {
  webSearch: boolean;
  thinking: boolean;
  fileProcessing: boolean;
}

/**
 * Everything access control needs about a user, resolved FRESH from the
 * database on every request (same invariant as the old users.plan read —
 * never from the JWT). INV-05: the backend derives access from this
 * snapshot alone; the frontend is display-only.
 */
export interface EntitlementSnapshot {
  /** Existing model-access layer still speaks 'free' | 'premium'. */
  tier: 'free' | 'premium';
  planSlug: string;
  planName: string;
  subscriptionId: string | null;
  currentPeriodEnd: string | null;
  quota: PlanQuota;
  features: PlanFeatures;
  /** null = all models allowed; a list restricts chat models to those ids. */
  allowedModelIds: string[] | null;
}

const FREE_PLAN_NAME = 'رایگان';

/**
 * Single source of truth for what a user may do. No `if (plan === 'pro')`
 * anywhere: paid capabilities come from the Plan row of the user's active
 * subscription; users without one get the env-configured free tier with
 * today's default behavior (web search / thinking / file processing allowed,
 * free-model restriction in resolveChatModel unchanged).
 */
@Injectable()
export class EntitlementsService {
  private readonly logger = new Logger(EntitlementsService.name);

  constructor(
    @InjectRepository(Plan)
    private readonly plansRepository: Repository<Plan>,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly configService: ConfigService,
  ) {}

  async resolveForUser(userId: string): Promise<EntitlementSnapshot> {
    const { snapshot } = await this.resolveWithSubscription(userId);
    return snapshot;
  }

  /**
   * One read for callers that need both the snapshot and the subscription
   * row (GET /billing/subscription/me). Also the lazy-expiration trigger
   * point: an overdue active period is expired before it can grant anything.
   */
  async resolveWithSubscription(userId: string): Promise<{
    snapshot: EntitlementSnapshot;
    subscription: {
      id: string;
      planSlug: string;
      planName: string;
      status: string;
      currentPeriodStart: Date;
      currentPeriodEnd: Date;
      sourcePaymentId: string | null;
    } | null;
  }> {
    const subscription = await this.subscriptionsService.getActiveOrExpire(userId);
    if (!subscription) {
      return { snapshot: this.freeSnapshot(), subscription: null };
    }
    const plan = await this.plansRepository.findOne({ where: { id: subscription.planId } });
    if (!plan) {
      // Data integrity fallback: never silently grant everything.
      this.logger.error(`PlanMissingForSubscription planId=${subscription.planId}`);
      return { snapshot: this.freeSnapshot(), subscription: null };
    }
    const snapshot: EntitlementSnapshot = {
      tier: 'premium',
      planSlug: plan.slug,
      planName: plan.name,
      subscriptionId: subscription.id,
      currentPeriodEnd: subscription.currentPeriodEnd.toISOString(),
      quota: {
        dailyMessages: plan.dailyMessageQuota,
        dailyTokens: plan.dailyTokenQuota,
      },
      features: {
        webSearch: plan.webSearch,
        thinking: plan.thinking,
        fileProcessing: plan.fileProcessing,
      },
      allowedModelIds: plan.allowedModelIds ?? null,
    };
    return {
      snapshot,
      subscription: {
        id: subscription.id,
        planSlug: subscription.planSlug,
        planName: subscription.planName,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        sourcePaymentId: subscription.sourcePaymentId,
      },
    };
  }

  /**
   * Free tier = no active subscription. Limits mirror QuotaService.quotaFor('free')
   * (same env keys and defaults); features preserve pre-billing behavior.
   */
  freeSnapshot(): EntitlementSnapshot {
    return {
      tier: 'free',
      planSlug: 'free',
      planName: FREE_PLAN_NAME,
      subscriptionId: null,
      currentPeriodEnd: null,
      quota: {
        dailyMessages: this.configService.get<number>('quota.freeDailyMessages') ?? 50,
        dailyTokens: this.configService.get<number | null>('quota.freeDailyTokens') ?? null,
      },
      features: { webSearch: true, thinking: true, fileProcessing: true },
      allowedModelIds: null,
    };
  }
}
