import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Editable theme metadata. `enabled` and `isDefault` are intentionally NOT
 * here — they have dedicated endpoints with their own invariants.
 */
export class UpdateThemeDto {
  @IsOptional()
  @IsString({ message: 'نام پوسته باید متن باشد.' })
  @MaxLength(80, { message: 'نام پوسته حداکثر ۸۰ کاراکتر است.' })
  name?: string;

  @IsOptional()
  @IsString({ message: 'توضیح پوسته باید متن باشد.' })
  @MaxLength(255, { message: 'توضیح پوسته حداکثر ۲۵۵ کاراکتر است.' })
  description?: string;

  @IsOptional()
  @IsInt({ message: 'ترتیب پوسته باید عدد صحیح باشد.' })
  @Min(0, { message: 'ترتیب پوسته نمی‌تواند منفی باشد.' })
  sortOrder?: number;
}
