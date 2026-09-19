import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  IsUUID,
} from 'class-validator';
import { CreatePlanDto } from './create-plan.dto';

/**
 * Partial update. `slug` is deliberately NOT updatable: it is the stable
 * identifier referenced by logs/audit metadata. Price changes affect only
 * FUTURE payments — historical payments keep their snapshot (INV-07).
 */
export class UpdatePlanDto implements Partial<CreatePlanDto> {
  @IsOptional()
  @IsString({ message: 'نام طرح باید متن باشد.' })
  @Length(1, 100, { message: 'نام طرح باید بین ۱ تا ۱۰۰ کاراکتر باشد.' })
  name?: string;

  @IsOptional()
  @IsString({ message: 'توضیحات باید متن باشد.' })
  @MaxLength(500, { message: 'توضیحات حداکثر ۵۰۰ کاراکتر است.' })
  description?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'قیمت باید عدد باشد.' })
  @Min(0, { message: 'قیمت نمی‌تواند منفی باشد.' })
  price?: number;

  @IsOptional()
  @IsString({ message: 'واحد پول باید متن باشد.' })
  @Length(3, 10, { message: 'واحد پول باید بین ۳ تا ۱۰ کاراکتر باشد.' })
  currency?: string;

  @IsOptional()
  @IsIn(['monthly', 'yearly'], { message: 'دوره صورتحساب باید ماهانه یا سالانه باشد.' })
  billingPeriod?: 'monthly' | 'yearly';

  @IsOptional()
  @IsInt({ message: 'سهمیه پیام روزانه باید عدد صحیح باشد.' })
  @Min(1, { message: 'سهمیه پیام روزانه باید حداقل ۱ باشد.' })
  @Max(1_000_000, { message: 'سهمیه پیام روزانه حداکثر ۱۰۰۰۰۰۰ است.' })
  dailyMessageQuota?: number;

  @IsOptional()
  @IsInt({ message: 'سهمیه توکن روزانه باید عدد صحیح باشد.' })
  @Min(1, { message: 'سهمیه توکن روزانه باید حداقل ۱ باشد.' })
  dailyTokenQuota?: number | null;

  @IsOptional()
  @IsArray({ message: 'فهرست مدل‌های مجاز باید آرایه باشد.' })
  @ArrayMaxSize(200, { message: 'فهرست مدل‌های مجاز حداکثر ۲۰۰ مورد است.' })
  @IsUUID('4', { each: true, message: 'شناسه مدل مجاز معتبر نیست.' })
  allowedModelIds?: string[] | null;

  @IsOptional()
  @IsBoolean({ message: 'دسترسی جستجوی وب باید بولی باشد.' })
  webSearch?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'دسترسی تفکر عمیق باید بولی باشد.' })
  thinking?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'دسترسی پردازش فایل باید بولی باشد.' })
  fileProcessing?: boolean;
}
