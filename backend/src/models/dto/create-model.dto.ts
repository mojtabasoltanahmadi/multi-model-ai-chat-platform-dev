import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
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
}
