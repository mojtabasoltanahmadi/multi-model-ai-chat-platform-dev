import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Plan } from './plan.entity';
import { AuditEventType, AuditService } from './audit.service';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';

/**
 * Admin-managed plan catalog. Adding/editing a plan is data entry — no code
 * change anywhere else. `slug` is immutable after creation.
 */
@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    @InjectRepository(Plan)
    private readonly plansRepository: Repository<Plan>,
    private readonly auditService: AuditService,
  ) {}

  listActive(): Promise<Plan[]> {
    return this.plansRepository.find({
      where: { isActive: true },
      order: { price: 'ASC' },
    });
  }

  listAll(): Promise<Plan[]> {
    return this.plansRepository.find({ order: { createdAt: 'ASC' } });
  }

  async create(dto: CreatePlanDto, actorId: string, actor: string | null): Promise<Plan> {
    const clash = await this.plansRepository.findOne({ where: { slug: dto.slug } });
    if (clash) {
      throw new ConflictException('طرحی با این شناسه از قبل وجود دارد.');
    }
    const plan = await this.plansRepository.save({
      ...dto,
      price: String(dto.price),
      dailyTokenQuota: dto.dailyTokenQuota ?? null,
      allowedModelIds: dto.allowedModelIds ?? null,
      description: dto.description ?? null,
      isActive: true,
    });
    await this.auditService.record(AuditEventType.PLAN_CREATED, {
      actorId,
      actor,
      target: `plan:${plan.id}`,
      metadata: { slug: plan.slug, price: plan.price, currency: plan.currency },
    });
    this.logger.log(`PlanCreated planId=${plan.id} slug=${plan.slug}`);
    return plan;
  }

  async update(planId: string, dto: UpdatePlanDto, actorId: string, actor: string | null): Promise<Plan> {
    const plan = await this.plansRepository.findOne({ where: { id: planId } });
    if (!plan) {
      throw new NotFoundException('طرح مورد نظر پیدا نشد.');
    }
    const changedFields = Object.keys(dto) as (keyof UpdatePlanDto)[];
    for (const field of changedFields) {
      const value = dto[field];
      if (value === undefined) continue;
      if (field === 'price') {
        plan.price = String(value);
      } else if (field === 'dailyTokenQuota' || field === 'allowedModelIds' || field === 'description') {
        (plan as unknown as Record<string, unknown>)[field] = value ?? null;
      } else {
        (plan as unknown as Record<string, unknown>)[field] = value;
      }
    }
    const saved = await this.plansRepository.save(plan);
    await this.auditService.record(AuditEventType.PLAN_UPDATED, {
      actorId,
      actor,
      target: `plan:${plan.id}`,
      metadata: { slug: plan.slug, changedFields },
    });
    return saved;
  }

  /**
   * Deactivation policy (documented in the billing decisions doc): a
   * deactivated plan cannot be PURCHASED anymore, but existing active
   * subscriptions run until their period ends, and history is untouched.
   */
  async setActive(planId: string, isActive: boolean, actorId: string, actor: string | null): Promise<Plan> {
    const plan = await this.plansRepository.findOne({ where: { id: planId } });
    if (!plan) {
      throw new NotFoundException('طرح مورد نظر پیدا نشد.');
    }
    if (plan.isActive !== isActive) {
      plan.isActive = isActive;
      await this.plansRepository.save(plan);
      await this.auditService.record(
        isActive ? AuditEventType.PLAN_ACTIVATED : AuditEventType.PLAN_DEACTIVATED,
        { actorId, actor, target: `plan:${plan.id}`, metadata: { slug: plan.slug } },
      );
      this.logger.log(`Plan${isActive ? 'Activated' : 'Deactivated'} planId=${plan.id}`);
    }
    return plan;
  }
}
