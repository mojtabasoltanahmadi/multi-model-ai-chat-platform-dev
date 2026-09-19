import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserPreference } from './user-preference.entity';
import { ThemesService } from '../themes/themes.service';

/**
 * Server-synced user preferences. Themes are validated at write time
 * (enabled only) and re-resolved at read time (a theme disabled after the
 * fact falls back to the system default), so a client can never apply an
 * unavailable theme through this service.
 */
@Injectable()
export class PreferencesService {
  constructor(
    @InjectRepository(UserPreference)
    private readonly preferencesRepository: Repository<UserPreference>,
    private readonly themesService: ThemesService,
  ) {}

  /**
   * Raw stored preference; null when the user never chose one. A null lets
   * the client keep its device-local choice (e.g. 'system') instead of
   * forcing the global default on it.
   */
  async getThemeId(userId: string): Promise<string | null> {
    const row = await this.preferencesRepository.findOne({ where: { userId } });
    return row?.themeId ?? null;
  }

  /**
   * The theme the user should actually see: stored preference resolved
   * through current availability (disabled/removed → default).
   */
  async getResolvedThemeId(userId: string): Promise<string> {
    return this.themesService.resolveAvailableThemeId(await this.getThemeId(userId));
  }

  /** Upserts the preference; only currently-enabled themes are accepted. */
  async setThemeId(userId: string, themeId: string): Promise<string> {
    if (!(await this.themesService.isThemeEnabled(themeId))) {
      throw new BadRequestException('این پوسته در دسترس نیست.');
    }

    const existing = await this.preferencesRepository.findOne({ where: { userId } });
    if (existing) {
      existing.themeId = themeId;
      await this.preferencesRepository.save(existing);
    } else {
      await this.preferencesRepository.insert(
        this.preferencesRepository.create({ userId, themeId }),
      );
    }
    return themeId;
  }
}
