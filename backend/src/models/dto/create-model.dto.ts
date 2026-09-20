import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { AiProviderKind } from '../ai-model.entity';
import { MODEL_CAPABILITIES } from '../model-capabilities';

/** All provider kinds that have a registered adapter. */
export const AI_PROVIDER_KINDS = [
  'mock',
  'openai-compatible',
  'anthropic',
  'google',
] as const;

export class CreateModelDto {
  @IsString()
  @IsNotEmpty({ message: 'نام مدل الزامی است.' })
  @MaxLength(100, { message: 'نام مدل حداکثر ۱۰۰ کاراکتر است.' })
  name: string;

  @IsIn(AI_PROVIDER_KINDS, { message: 'نوع ارائه‌دهنده معتبر نیست.' })
  provider: AiProviderKind;

  @IsString()
  @IsNotEmpty({ message: 'شناسه مدل در سرویس‌دهنده الزامی است.' })
  @MaxLength(200, { message: 'شناسه مدل حداکثر ۲۰۰ کاراکتر است.' })
  externalModelId: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'آدرس پایه حداکثر ۵۰۰ کاراکتر است.' })
  baseUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'کلید API حداکثر ۵۰۰ کاراکتر است.' })
  apiKey?: string;

  @IsOptional()
  @IsArray({ message: 'قابلیت‌ها باید آرایه باشند.' })
  @ArrayMaxSize(MODEL_CAPABILITIES.length, { message: 'قابلیت‌های بیش از حد مجاز.' })
  @IsIn(MODEL_CAPABILITIES as unknown as string[], {
    each: true,
    message: 'قابلیت واردشده معتبر نیست.',
  })
  capabilities?: string[];

  @IsOptional()
  @IsBoolean({ message: 'وضعیت فعال باید true یا false باشد.' })
  isActive?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'وضعیت رایگان باید true یا false باشد.' })
  isFree?: boolean;

  /**
   * Optional single-hop fallback model (day-7-8 contract §12): used once,
   * only when this model's provider fails with a retryable kind before the
   * first streamed token. Validated in the service (must exist, be active,
   * not self, at least as accessible as this model).
   */
  @IsOptional()
  @IsUUID('4', { message: 'شناسه مدل جایگزین نامعتبر است.' })
  fallbackModelId?: string;

  /** Toman per 1M input tokens; empty/0 ⇒ model is not priced (cost null). */
  @IsOptional()
  @IsString({ message: 'قیمت ورودی باید عدد باشد.' })
  @MaxLength(20, { message: 'قیمت ورودی حداکثر ۲۰ کاراکتر است.' })
  inputPricePerMillion?: string;

  /** Toman per 1M output tokens; empty/0 ⇒ model is not priced (cost null). */
  @IsOptional()
  @IsString({ message: 'قیمت خروجی باید عدد باشد.' })
  @MaxLength(20, { message: 'قیمت خروجی حداکثر ۲۰ کاراکتر است.' })
  outputPricePerMillion?: string;
}
