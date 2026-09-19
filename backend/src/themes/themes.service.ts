import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Theme } from './theme.entity';
import { THEME_IDS, THEME_REGISTRY, ThemeId } from './theme-registry';
import { UpdateThemeDto } from './dto/update-theme.dto';
import { ReorderThemesDto } from './dto/reorder-themes.dto';

/** Shared display ordering: explicit order first, id as a stable tiebreaker. */
const LIST_ORDER = { sortOrder: 'ASC', id: 'ASC' } as const;

/**
 * Theme availability is admin-controlled server state. Invariants maintained
 * here (the frontend is never trusted):
 * - at least one theme stays enabled;
 * - at most one default theme, and a default is always enabled;
 * - disabling the current default automatically moves the default to the
 *   first remaining enabled theme (no "default + disabled" state can exist);
 * - unknown theme ids are rejected before they touch the database.
 */
@Injectable()
export class ThemesService implements OnModuleInit {
  constructor(
    @InjectRepository(Theme)
    private readonly themesRepository: Repository<Theme>,
  ) {}

  /**
   * Seed-on-init: every registry theme gets a row exactly once (idempotent on
   * every boot, picks up newly added registry themes on existing installs).
   * Afterwards the default invariant is repaired if data drifted (e.g. a
   * manual database edit left no enabled default).
   */
  async onModuleInit(): Promise<void> {
    const existing = await this.themesRepository.find();
    const knownIds = new Set(existing.map((theme) => theme.id));

    const missing = THEME_REGISTRY.filter((seed) => !knownIds.has(seed.id));
    if (missing.length > 0) {
      const hasDefault = existing.some((theme) => theme.isDefault);
      await this.themesRepository.save(
        missing.map((seed) =>
          this.themesRepository.create({
            id: seed.id,
            name: seed.name,
            description: seed.description,
            enabled: true,
            isDefault: !hasDefault && seed.id === 'light',
            sortOrder: seed.sortOrder,
            metadata: null,
          }),
        ),
      );
    }

    await this.repairDefaultInvariant();
  }

  /** All themes for the admin panel, in display order. */
  async listAll(): Promise<Theme[]> {
    return this.themesRepository.find({ order: { ...LIST_ORDER } });
  }

  /** Themes users may select (enabled only), in display order. */
  async listAvailable(): Promise<Theme[]> {
    return this.themesRepository.find({
      where: { enabled: true },
      order: { ...LIST_ORDER },
    });
  }

  /**
   * Enable/disable. Disabling the last enabled theme is refused; disabling
   * the default moves the default to the first remaining enabled theme
   * within the same call, so the response is always a consistent state.
   */
  async updateStatus(themeId: string, enabled: boolean): Promise<Theme> {
    const theme = await this.getTheme(themeId);
    if (theme.enabled === enabled) return theme;

    if (!enabled) {
      const enabledCount = await this.themesRepository.count({ where: { enabled: true } });
      if (enabledCount <= 1) {
        throw new BadRequestException('حداقل یک پوسته باید فعال بماند.');
      }
      if (theme.isDefault) {
        const fallback = await this.themesRepository.findOne({
          where: { enabled: true },
          order: { ...LIST_ORDER },
        });
        if (fallback && fallback.id !== theme.id) {
          await this.themesRepository.update({ id: fallback.id }, { isDefault: true });
        }
        theme.isDefault = false;
      }
    }

    theme.enabled = enabled;
    return this.themesRepository.save(theme);
  }

  /**
   * Invariant: exactly one default and it must be enabled — mirroring the
   * default-model rules (must be usable by every user).
   */
  async setDefault(themeId: string): Promise<Theme> {
    const theme = await this.getTheme(themeId);
    if (!theme.enabled) {
      throw new BadRequestException('ابتدا پوسته را فعال کنید؛ پوسته غیرفعال نمی‌تواند پیش‌فرض شود.');
    }
    if (theme.isDefault) return theme;

    await this.themesRepository.manager.transaction(async (entityManager: EntityManager) => {
      await entityManager.update(Theme, { isDefault: true }, { isDefault: false });
      await entityManager.update(Theme, { id: theme.id }, { isDefault: true });
    });

    theme.isDefault = true;
    return theme;
  }

  /** Edits display metadata (name/description/order). */
  async update(themeId: string, dto: UpdateThemeDto): Promise<Theme> {
    const theme = await this.getTheme(themeId);
    if (dto.name !== undefined) theme.name = dto.name.trim();
    if (dto.description !== undefined) {
      theme.description = dto.description.trim() || null;
    }
    if (dto.sortOrder !== undefined) theme.sortOrder = dto.sortOrder;
    return this.themesRepository.save(theme);
  }

  /**
   * Applies a complete display order. Partial lists and duplicates are
   * refused so an accidental half-order can never scramble the rest.
   */
  async reorder(dto: ReorderThemesDto): Promise<Theme[]> {
    const requested = dto.themeIds;
    const unique = new Set(requested);
    const complete = THEME_IDS.every((id) => unique.has(id));
    if (unique.size !== requested.length || !complete) {
      throw new BadRequestException('ترتیب ارسالی باید شامل همه پوسته‌ها بدون تکرار باشد.');
    }

    await this.themesRepository.manager.transaction(async (entityManager: EntityManager) => {
      for (const [index, id] of requested.entries()) {
        await entityManager.update(Theme, { id }, { sortOrder: index + 1 });
      }
    });

    return this.listAll();
  }

  /** Whether users may currently select this theme (preference write gate). */
  async isThemeEnabled(themeId: string): Promise<boolean> {
    return this.themesRepository.exists({ where: { id: themeId, enabled: true } });
  }

  /**
   * Fallback resolution for the stored user preference: the preference if
   * still available → the default → the first enabled theme → the built-in
   * safe default. Never returns an unknown or disabled theme unless the
   * table is unreachable-empty, mirroring the client resolver.
   */
  async resolveAvailableThemeId(preference: string | null | undefined): Promise<ThemeId> {
    if (preference) {
      const preferred = await this.themesRepository.findOne({
        where: { id: preference, enabled: true },
      });
      if (preferred) return preferred.id as ThemeId;
    }
    const preferredDefault = await this.themesRepository.findOne({
      where: { enabled: true, isDefault: true },
    });
    if (preferredDefault) return preferredDefault.id as ThemeId;

    const firstEnabled = await this.themesRepository.findOne({
      where: { enabled: true },
      order: { ...LIST_ORDER },
    });
    if (firstEnabled) return firstEnabled.id as ThemeId;
    return 'light';
  }

  /**
   * Guarantees a default exists and is enabled: promotes the first enabled
   * theme when the flag drifted, or revives `light` when nothing is enabled.
   */
  private async repairDefaultInvariant(): Promise<void> {
    const defaultTheme = await this.themesRepository.findOne({ where: { isDefault: true } });
    if (defaultTheme?.enabled) return;

    const firstEnabled = await this.themesRepository.findOne({
      where: { enabled: true },
      order: { ...LIST_ORDER },
    });
    if (firstEnabled) {
      await this.themesRepository.update({ isDefault: true }, { isDefault: false });
      await this.themesRepository.update({ id: firstEnabled.id }, { isDefault: true });
      return;
    }

    // Nothing enabled (only possible through manual data edits) — restore the
    // factory state so the app always has a valid default theme.
    await this.themesRepository.update({ id: 'light' }, { enabled: true, isDefault: true });
  }

  private async getTheme(themeId: string): Promise<Theme> {
    const theme = await this.themesRepository.findOne({ where: { id: themeId } });
    if (!theme) throw new NotFoundException('پوسته پیدا نشد.');
    return theme;
  }
}
