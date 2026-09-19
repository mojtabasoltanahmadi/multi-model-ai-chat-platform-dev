import { IsIn } from 'class-validator';
import { THEME_IDS } from '../../themes/theme-registry';

/** Unknown ids are rejected at the DTO boundary (no theme injection). */
export class UpdateThemePreferenceDto {
  @IsIn(THEME_IDS, { message: 'پوسته درخواستی معتبر نیست.' })
  themeId: string;
}
