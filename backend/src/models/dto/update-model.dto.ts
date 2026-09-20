import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { AI_PROVIDER_KINDS } from './create-model.dto';
import { AiProviderKind } from '../ai-model.entity';
import { MODEL_CAPABILITIES } from '../model-capabilities';

/** Partial update; unknown fields are stripped by the global ValidationPipe. */
export class UpdateModelDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsIn(AI_PROVIDER_KINDS)
  provider?: AiProviderKind;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalModelId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
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
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isFree?: boolean;

  /**
   * Optional single-hop fallback model; an explicit `null` clears it.
   * Validated in the service (must exist, be active, not self, at least as
   * accessible as this model).
   */
  @IsOptional()
  @IsUUID('4', { message: 'شناسه مدل جایگزین نامعتبر است.' })
  fallbackModelId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  inputPricePerMillion?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  outputPricePerMillion?: string | null;
}
