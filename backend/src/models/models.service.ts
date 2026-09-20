import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { AiModel } from './ai-model.entity';
import { normalizeCapabilities } from './model-capabilities';
import { CreateModelDto } from './dto/create-model.dto';
import { UpdateModelDto } from './dto/update-model.dto';

/**
 * Shape returned to ANY client — strips the provider API key AND pricing
 * (INV-14: pricing is admin-only). Admin endpoints add the pricing back.
 * `hasFallback` tells clients a single-hop fallback is configured (day-7-8
 * contract §16) without leaking the fallback row itself.
 */
export type SafeModel = Omit<
  AiModel,
  'apiKey' | 'inputPricePerMillion' | 'outputPricePerMillion' | 'fallbackModel'
> & {
  hasApiKey: boolean;
  hasFallback: boolean;
};

/** Admin serializer output: SafeModel + pricing. */
export type AdminSafeModel = SafeModel & {
  inputPricePerMillion: string | null;
  outputPricePerMillion: string | null;
};

/**
 * User plans (day-7-8 contract §8). The plan is read FRESH from the users
 * table per request; 'free' remains the default while premium unlocks
 * models with isFree=false.
 */
export type UserPlan = 'free' | 'premium';

@Injectable()
export class ModelsService {
  constructor(
    @InjectRepository(AiModel)
    private readonly modelsRepository: Repository<AiModel>,
  ) {}

  /** All models for the admin panel (API key stripped, pricing included). */
  async listAll(): Promise<AdminSafeModel[]> {
    const models = await this.modelsRepository.find({ order: { createdAt: 'ASC' } });
    return models.map((model) => this.toAdminSafeModel(model));
  }

  /**
   * Models the given plan may actually use - the plan-filtered list the chat
   * UI offers. The backend is the source of truth: hiding in the frontend is
   * not authorization (INV-2: active AND allowed for the plan).
   */
  async listAvailable(plan: UserPlan = 'free'): Promise<SafeModel[]> {
    const where =
      plan === 'free' ? { isActive: true, isFree: true } : { isActive: true };
    const models = await this.modelsRepository.find({ where, order: { createdAt: 'ASC' } });
    return models.map((model) => this.toSafeModel(model));
  }

  async create(dto: CreateModelDto): Promise<AdminSafeModel> {
    const willBeActive = dto.isActive ?? true;
    const willBeFree = dto.isFree ?? true;

    if (dto.fallbackModelId) {
      await this.assertFallbackAllowed({ isFree: willBeFree }, dto.fallbackModelId);
    }

    const model = this.modelsRepository.create({
      name: dto.name.trim(),
      provider: dto.provider,
      externalModelId: dto.externalModelId.trim(),
      baseUrl: dto.baseUrl?.trim() || null,
      apiKey: dto.apiKey?.trim() || null,
      capabilities: normalizeCapabilities(dto.capabilities),
      inputPricePerMillion: normalizePrice(dto.inputPricePerMillion),
      outputPricePerMillion: normalizePrice(dto.outputPricePerMillion),
      fallbackModelId: dto.fallbackModelId ?? null,
      isActive: willBeActive,
      isFree: willBeFree,
      isDefault: false,
    });

    // Convenience only: the first active model automatically becomes the
    // default so a fresh installation can chat right away. The default must
    // satisfy the same rules as setDefault: active AND free.
    const defaultExists = await this.modelsRepository.exists({ where: { isDefault: true } });
    if (willBeActive && willBeFree && !defaultExists) {
      model.isDefault = true;
    }

    return this.toAdminSafeModel(await this.modelsRepository.save(model));
  }

  async update(id: string, dto: UpdateModelDto): Promise<AdminSafeModel> {
    const model = await this.modelsRepository.findOne({ where: { id } });
    if (!model) throw new NotFoundException('مدل پیدا نشد.');

    if (dto.isActive === false && model.isDefault) {
      throw new BadRequestException(
        'مدل پیش‌فرض را نمی‌توان غیرفعال کرد. ابتدا یک مدل دیگر را پیش‌فرض کنید.',
      );
    }
    // The default model must stay usable by FREE users (INV-3 for defaults).
    if (dto.isFree === false && model.isDefault) {
      throw new BadRequestException(
        'مدل پیش‌فرض باید برای کاربران رایگان در دسترس باشد. ابتدا یک مدل دیگر را پیش‌فرض کنید.',
      );
    }

    if (dto.name !== undefined) model.name = dto.name.trim();
    if (dto.provider !== undefined) model.provider = dto.provider;
    if (dto.externalModelId !== undefined) model.externalModelId = dto.externalModelId.trim();
    if (dto.baseUrl !== undefined) model.baseUrl = dto.baseUrl?.trim() || null;
    if (dto.apiKey !== undefined) model.apiKey = dto.apiKey.trim() || null;
    if (dto.capabilities !== undefined) model.capabilities = normalizeCapabilities(dto.capabilities);
    if (dto.inputPricePerMillion !== undefined) {
      model.inputPricePerMillion = normalizePrice(dto.inputPricePerMillion);
    }
    if (dto.outputPricePerMillion !== undefined) {
      model.outputPricePerMillion = normalizePrice(dto.outputPricePerMillion);
    }
    if (dto.fallbackModelId !== undefined) {
      // An explicit null clears the fallback; a value is validated against
      // the model's EFFECTIVE accessibility (dto.isFree may change it too).
      if (dto.fallbackModelId !== null) {
        await this.assertFallbackAllowed(
          { id: model.id, isFree: dto.isFree ?? model.isFree },
          dto.fallbackModelId,
        );
      }
      model.fallbackModelId = dto.fallbackModelId;
    }
    if (dto.isActive !== undefined) model.isActive = dto.isActive;
    if (dto.isFree !== undefined) model.isFree = dto.isFree;

    return this.toAdminSafeModel(await this.modelsRepository.save(model));
  }

  /**
   * Invariant: at most one default model, and it must be active and free.
   * The swap runs in a transaction so both rows change atomically.
   */
  async setDefault(id: string): Promise<AdminSafeModel> {
    const model = await this.modelsRepository.findOne({ where: { id } });
    if (!model) throw new NotFoundException('مدل پیدا نشد.');
    if (!model.isActive) {
      throw new BadRequestException('فقط مدل فعال می‌تواند پیش‌فرض شود.');
    }
    if (!model.isFree) {
      throw new BadRequestException(
        'مدل پیش‌فرض باید برای کاربران رایگان در دسترس باشد.',
      );
    }

    await this.modelsRepository.manager.transaction(async (entityManager: EntityManager) => {
      await entityManager.update(AiModel, { isDefault: true }, { isDefault: false });
      await entityManager.update(AiModel, { id: model.id }, { isDefault: true });
    });

    model.isDefault = true;
    return this.toAdminSafeModel(model);
  }

  async remove(id: string): Promise<void> {
    const model = await this.modelsRepository.findOne({ where: { id } });
    if (!model) throw new NotFoundException('مدل پیدا نشد.');
    if (model.isDefault) {
      throw new BadRequestException(
        'مدل پیش‌فرض قابل حذف نیست. ابتدا یک مدل دیگر را پیش‌فرض کنید.',
      );
    }
    await this.modelsRepository.remove(model);
  }

  /**
   * Resolves the model for a new chat turn — the single authorization
   * chokepoint for chat. The requested model (or the default when none is
   * given) must exist, be active, AND be allowed for the caller's plan.
   * Frontend filtering is never trusted; every send re-checks here against
   * current backend state (concurrent admin changes are honored).
   */
  async resolveChatModel(modelId: string | undefined, plan: UserPlan = 'free'): Promise<AiModel> {
    if (modelId) {
      const model = await this.modelsRepository.findOne({ where: { id: modelId } });
      if (!model) throw new NotFoundException('مدل درخواستی پیدا نشد.');
      if (!model.isActive) {
        throw new BadRequestException('این مدل غیرفعال است و قابل استفاده نیست.');
      }
      if (plan === 'free' && !model.isFree) {
        // Premium model requested by a free user (direct API call included).
        throw new ForbiddenException('این مدل برای طرح شما در دسترس نیست.');
      }
      return model;
    }

    const model = await this.modelsRepository.findOne({ where: { isDefault: true } });
    if (!model) {
      throw new BadRequestException(
        'هنوز مدل پیش‌فرضی تنظیم نشده است. با مدیر سیستم تماس بگیرید.',
      );
    }
    if (!model.isActive) {
      throw new BadRequestException('مدل پیش‌فرض غیرفعال است. با مدیر سیستم تماس بگیرید.');
    }
    if (plan === 'free' && !model.isFree) {
      throw new BadRequestException(
        'مدل پیش‌فرض برای طرح شما در دسترس نیست. با مدیر سیستم تماس بگیرید.',
      );
    }
    return model;
  }

  async existingByIds(ids: string[]): Promise<AiModel[]> {
    if (ids.length === 0) return [];
    return this.modelsRepository.find({ where: { id: In(ids) } });
  }

  /**
   * Resolves the single-hop fallback for a failing generation at runtime
   * (day-7-8 contract §12). Returns null when the configured fallback cannot
   * serve the caller — the turn then fails with the original provider error
   * instead of falling back into a 403/inactive model. Fresh DB read: admin
   * changes made after the primary was resolved are honored here.
   */
  async resolveFallbackCandidate(
    fallbackModelId: string,
    plan: UserPlan,
    access?: { allowedModelIds: string[] | null; features: { thinking: boolean } },
  ): Promise<AiModel | null> {
    const fallback = await this.modelsRepository.findOne({ where: { id: fallbackModelId } });
    if (!fallback || !fallback.isActive) return null;
    if (plan === 'free' && !fallback.isFree) return null;
    if (access?.allowedModelIds && !access.allowedModelIds.includes(fallback.id)) return null;
    if (access && !access.features.thinking && fallback.capabilities.includes('reasoning')) {
      return null;
    }
    return fallback;
  }

  /**
   * Admin-boundary fallback rules (day-7-8 contract §12): the fallback must
   * exist, be active, not be the model itself, and be at least as accessible
   * as the primary — a free-plan model may never fall back into a
   * free-plan-forbidden (premium) model.
   */
  private async assertFallbackAllowed(
    primary: { id?: string; isFree: boolean },
    fallbackModelId: string,
  ): Promise<void> {
    if (primary.id && primary.id === fallbackModelId) {
      throw new BadRequestException('یک مدل نمی‌تواند جایگزین خودش باشد.');
    }
    const fallback = await this.modelsRepository.findOne({ where: { id: fallbackModelId } });
    if (!fallback) {
      throw new BadRequestException('مدل جایگزین پیدا نشد.');
    }
    if (!fallback.isActive) {
      throw new BadRequestException('مدل جایگزین باید فعال باشد.');
    }
    if (primary.isFree && !fallback.isFree) {
      throw new BadRequestException(
        'مدل جایگزین باید حداقل به اندازه مدل اصلی در دسترس باشد.',
      );
    }
  }

  private toSafeModel(model: AiModel): SafeModel {
    const {
      apiKey,
      inputPricePerMillion,
      outputPricePerMillion,
      fallbackModel,
      ...rest
    } = model;
    return {
      ...rest,
      hasApiKey: Boolean(apiKey),
      hasFallback: Boolean(model.fallbackModelId),
    };
  }

  private toAdminSafeModel(model: AiModel): AdminSafeModel {
    return {
      ...this.toSafeModel(model),
      inputPricePerMillion: model.inputPricePerMillion,
      outputPricePerMillion: model.outputPricePerMillion,
    };
  }
}

/**
 * Normalizes a price value from the DTO boundary: trims, drops empty/zero
 * strings to null ("not priced"), keeps numeric strings for Postgres numeric.
 */
function normalizePrice(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return raw;
}
