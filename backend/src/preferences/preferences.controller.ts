import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PreferencesService } from './preferences.service';
import { UpdateThemePreferenceDto } from './dto/update-theme-preference.dto';

interface AuthUser {
  id: string;
  email: string;
  role: string;
}

/**
 * Signed-in user preferences. Any authenticated user may read/write their
 * own row; there are no admin-only fields here by design.
 */
@Controller('users/me/preferences')
export class PreferencesController {
  constructor(private readonly preferencesService: PreferencesService) {}

  /**
   * Resolved theme: the stored preference, or null when the user never chose
   * one. A stored theme that has since been disabled resolves to the system
   * default before it ever reaches the client.
   */
  @Get()
  async show(@CurrentUser() user: AuthUser): Promise<{ themeId: string | null }> {
    const stored = await this.preferencesService.getThemeId(user.id);
    if (!stored) return { themeId: null };
    return { themeId: await this.preferencesService.getResolvedThemeId(user.id) };
  }

  @Patch('theme')
  async updateTheme(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateThemePreferenceDto,
  ): Promise<{ themeId: string }> {
    const themeId = await this.preferencesService.setThemeId(user.id, dto.themeId);
    return { themeId };
  }
}
