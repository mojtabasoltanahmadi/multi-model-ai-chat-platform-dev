import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AiModel } from '../models/ai-model.entity';
import { User } from '../users/user.entity';
import { UsageOutcome, UsageRecord } from './usage-record.entity';

/** Data needed to open a usage row at turn acceptance. */
export interface UsageTurnStart {
  userId: string;
  conversationId: string;
  messageId: string;
  model: Pick<AiModel, 'id' | 'provider' | 'inputPricePerMillion' | 'outputPricePerMillion'>;
  /** Characters sent to the provider (history + contextual prompt). */
  inputChars: number;
}

/** Terminal facts gathered by the generation loop. */
export interface UsageTurnEnd {
  outcome: Exclude<UsageOutcome, 'pending'>;
  /** Provider-reported tokens; null ⇒ chars/4 estimate with estimated=true. */
  inputTokens: number | null;
  outputTokens: number | null;
  outputChars: number;
}

const CHARS_PER_TOKEN = 4;

/**
 * Owns the usage_records lifecycle (day-7-8 contract §7):
 *   insert at turn acceptance (same transaction as the user row),
 *   exactly one terminal update, best-effort — a usage failure must never
 *   fail the message save. Reconnects touch nothing.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    @InjectRepository(UsageRecord)
    private readonly usageRepository: Repository<UsageRecord>,
  ) {}

  /**
   * Records turn acceptance. Runs INSIDE the beginChatTurn transaction so a
   * crash can never leave an accepted user row without its usage row.
   * INSERT (not UPDATE) + the unique message_id make replays structurally
   * unable to double-record.
   */
  async recordTurnStart(manager: EntityManager, turn: UsageTurnStart): Promise<void> {
    await manager.insert(UsageRecord, {
      userId: turn.userId,
      conversationId: turn.conversationId,
      messageId: turn.messageId,
      modelId: turn.model.id,
      provider: turn.model.provider,
      inputChars: turn.inputChars,
      inputTokens: null,
      outputTokens: null,
      outputChars: 0,
      cost: null,
      estimated: false,
      outcome: 'pending' as UsageOutcome,
    });
  }

  /**
   * Terminal update — exactly once per turn, best-effort. Tokens come from
   * the provider's usage event when it reported one; otherwise both token
   * counts are estimated from characters (chars/4, documented heuristic) and
   * `estimated` is set. Cost is computed only for priced models.
   */
  async recordTurnEnd(messageId: string, end: UsageTurnEnd): Promise<void> {
    try {
      const record = await this.usageRepository.findOne({
        where: { messageId },
        select: ['id', 'modelId', 'inputChars'],
      });
      if (!record) {
        this.logger.error(`Usage row missing at terminal for ${messageId} — not recording.`);
        return;
      }

      const estimated = end.inputTokens === null || end.outputTokens === null;
      const inputTokens =
        end.inputTokens ?? Math.ceil(record.inputChars / CHARS_PER_TOKEN);
      const outputTokens = end.outputTokens ?? Math.ceil(end.outputChars / CHARS_PER_TOKEN);
      const cost = await this.computeCost(record.modelId, inputTokens, outputTokens);

      const update: Partial<UsageRecord> = {
        inputTokens,
        outputTokens,
        outputChars: end.outputChars,
        outcome: end.outcome,
        estimated,
        completedAt: new Date(),
      };
      if (cost !== null) update.cost = cost;

      await this.usageRepository.update({ messageId }, update);
      this.logger.log(
        `TurnUsage messageId=${messageId} outcome=${end.outcome} inTok=${inputTokens} ` +
          `outTok=${outputTokens} outChars=${end.outputChars} cost=${cost ?? 'null'} estimated=${estimated}`,
      );
    } catch (error) {
      // Never let accounting break the chat turn.
      this.logger.error(`Usage terminal update failed for ${messageId}: ${String(error)}`);
    }
  }

  /**
   * Cost in Toman: (tokens / 1M) × price per 1M, summed over input/output.
   * NULL when the model vanished (SET NULL) or either price is missing
   * (§7.7: null price ⇒ cost null).
   */
  private async computeCost(
    modelId: string | null,
    inputTokens: number,
    outputTokens: number,
  ): Promise<string | null> {
    if (!modelId) return null;

    const model = await this.usageRepository.manager.findOne(AiModel, {
      where: { id: modelId },
      select: ['id', 'inputPricePerMillion', 'outputPricePerMillion'],
    });
    if (!model) return null;

    const inputPrice = model.inputPricePerMillion ? Number(model.inputPricePerMillion) : null;
    const outputPrice = model.outputPricePerMillion ? Number(model.outputPricePerMillion) : null;
    if (inputPrice === null && outputPrice === null) return null;

    const cost =
      (inputPrice !== null ? (inputTokens / 1_000_000) * inputPrice : 0) +
      (outputPrice !== null ? (outputTokens / 1_000_000) * outputPrice : 0);
    return cost.toFixed(6);
  }

  /**
   * Admin aggregation (user consumption, model usage, cost overview). ALL
   * outcomes are included — cost reporting must show real consumption even
   * for failed turns (the failed-outcome exclusion is a QUOTA rule only).
   * Numeric sums arrive as Postgres strings; they are parsed to plain
   * numbers for the JSON response (MVP display precision).
   */
  async adminSummary(days: number): Promise<AdminUsageSummary> {
    const since = new Date(Date.now() - (days - 1) * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);

    // Each aggregation builds its own QueryBuilder with ENTITY property
    // names (TypeORM maps them to the quoted snake_case columns).
    const totalsRow = await this.usageRepository
      .createQueryBuilder('usage')
      .select('COUNT(*)', 'turns')
      .addSelect("COUNT(*) FILTER (WHERE \"usage\".\"outcome\" = 'failed')", 'failedTurns')
      .addSelect('COALESCE(SUM(COALESCE(usage.inputTokens, 0)), 0)', 'inputTokens')
      .addSelect('COALESCE(SUM(COALESCE(usage.outputTokens, 0)), 0)', 'outputTokens')
      .addSelect('COALESCE(SUM(usage.cost), 0)', 'cost')
      .where('usage.createdAt >= :since', { since })
      .getRawOne();

    const perDay = await this.usageRepository
      .createQueryBuilder('usage')
      .select("TO_CHAR(usage.createdAt, 'YYYY-MM-DD')", 'date')
      .addSelect('COUNT(*)', 'turns')
      .addSelect(
        'COALESCE(SUM(COALESCE(usage.inputTokens, 0) + COALESCE(usage.outputTokens, 0)), 0)',
        'tokens',
      )
      .addSelect('COALESCE(SUM(usage.cost), 0)', 'cost')
      .where('usage.createdAt >= :since', { since })
      .groupBy("TO_CHAR(usage.createdAt, 'YYYY-MM-DD')")
      .orderBy("TO_CHAR(usage.createdAt, 'YYYY-MM-DD')", 'DESC')
      .getRawMany();

    const perModel = await this.usageRepository
      .createQueryBuilder('usage')
      .leftJoin(AiModel, 'model', 'model.id = usage.modelId')
      .select('usage.modelId', 'modelId')
      .addSelect('model.name', 'modelName')
      .addSelect('model.provider', 'provider')
      .addSelect('COUNT(*)', 'turns')
      .addSelect(
        'COALESCE(SUM(COALESCE(usage.inputTokens, 0) + COALESCE(usage.outputTokens, 0)), 0)',
        'tokens',
      )
      .addSelect('COALESCE(SUM(usage.cost), 0)', 'cost')
      .where('usage.createdAt >= :since', { since })
      .groupBy('usage.modelId')
      .addGroupBy('model.name')
      .addGroupBy('model.provider')
      .orderBy('cost', 'DESC')
      .getRawMany();

    const perUser = await this.usageRepository
      .createQueryBuilder('usage')
      .innerJoin(User, 'member', 'member.id = usage.userId')
      .select('usage.userId', 'userId')
      .addSelect('member.email', 'email')
      .addSelect('COUNT(*)', 'turns')
      .addSelect(
        'COALESCE(SUM(COALESCE(usage.inputTokens, 0) + COALESCE(usage.outputTokens, 0)), 0)',
        'tokens',
      )
      .addSelect('COALESCE(SUM(usage.cost), 0)', 'cost')
      .where('usage.createdAt >= :since', { since })
      .groupBy('usage.userId')
      .addGroupBy('member.email')
      .orderBy('cost', 'DESC')
      .getRawMany();

    const inputTokens = num(totalsRow?.inputTokens);
    const outputTokens = num(totalsRow?.outputTokens);
    return {
      days,
      totals: {
        turns: num(totalsRow?.turns),
        failedTurns: num(totalsRow?.failedTurns),
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimatedCost: round2(num(totalsRow?.cost)),
      },
      perDay: perDay.map((row) => ({
        date: row.date,
        turns: num(row.turns),
        tokens: num(row.tokens),
        cost: round2(num(row.cost)),
      })),
      perModel: perModel.map((row) => ({
        modelId: row.modelId,
        modelName: row.modelName ?? null,
        provider: row.provider ?? null,
        turns: num(row.turns),
        tokens: num(row.tokens),
        cost: round2(num(row.cost)),
      })),
      perUser: perUser.map((row) => ({
        userId: row.userId,
        email: row.email,
        turns: num(row.turns),
        tokens: num(row.tokens),
        cost: round2(num(row.cost)),
      })),
    };
  }
}

export interface UsageSplitRow {
  turns: number;
  tokens: number;
  cost: number;
}

export interface AdminUsageSummary {
  days: number;
  totals: {
    turns: number;
    failedTurns: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCost: number;
  };
  perDay: (UsageSplitRow & { date: string })[];
  perModel: (UsageSplitRow & {
    modelId: string | null;
    modelName: string | null;
    provider: string | null;
  })[];
  perUser: (UsageSplitRow & { userId: string; email: string })[];
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
