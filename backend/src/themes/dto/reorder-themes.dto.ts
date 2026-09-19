import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn } from 'class-validator';
import { THEME_IDS } from '../theme-registry';

/**
 * Complete display order of the themes. The service additionally rejects
 * duplicates and partial lists, so every reorder is a full permutation of
 * the registry.
 */
export class ReorderThemesDto {
  @IsArray({ message: 'ترتیب پوسته‌ها باید آرایه باشد.' })
  @ArrayNotEmpty({ message: 'ترتیب پوسته‌ها نمی‌تواند خالی باشد.' })
  @ArrayMaxSize(THEME_IDS.length, { message: 'ترتیب ارسالی بیش از حد پوسته دارد.' })
  @IsIn(THEME_IDS, { each: true, message: 'شناسه پوسته نامعتبر است.' })
  themeIds: string[];
}
