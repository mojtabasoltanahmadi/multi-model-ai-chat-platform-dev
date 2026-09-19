import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Slugs are identifiers, never access logic — but keep them URL-friendly. */
export class CreatePlanDto {
  @IsString({ message: 'شناسه طرح باید متن باشد.' })
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'شناسه طرح باید ترکیبی از حروف کوچک، عدد و خط تیره باشد.' })
  @Length(2, 50, { message: 'شناسه طرح باید بین ۲ تا ۵۰ کاراکتر باشد.' })
  slug: string;

  @IsString({ message: 'نام طرح باید متن باشد.' })
  @Length(1, 100, { message: 'نام طرح باید بین ۱ تا ۱۰۰ کاراکتر باشد.' })
  name: string;

  @IsOptional()
  @IsString({ message: 'توضیحات باید متن باشد.' })
  @MaxLength(500, { message: 'توضیحات حداکثر ۵۰۰ کاراکتر است.' })
  description?: string | null;

  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'قیمت باید عدد باشد.' })
  @Min(0, { message: 'قیمت نمی‌تواند منفی باشد.' })
  price: number;

  @IsString({ message: 'واحد پول باید متن باشد.' })
  @Length(3, 10, { message: 'واحد پول باید بین ۳ تا ۱۰ کاراکتر باشد.' })
  currency: string = 'IRT';

  @IsIn(['monthly', 'yearly'], { message: 'دوره صورتحساب باید ماهانه یا سالانه باشد.' })
  billingPeriod: 'monthly' | 'yearly' = 'monthly';

  @IsInt({ message: 'سهمیه پیام روزانه باید عدد صحیح باشد.' })
  @Min(1, { message: 'سهمیه پیام روزانه باید حداقل ۱ باشد.' })
  @Max(1_000_000, { message: 'سهمیه پیام روزانه حداکثر ۱۰۰۰۰۰۰ است.' })
  dailyMessageQuota: number;

  @IsOptional()
  @IsInt({ message: 'سهمیه توکن روزانه باید عدد صحیح باشد.' })
  @Min(1, { message: 'سهمیه توکن روزانه باید حداقل ۱ باشد.' })
  dailyTokenQuota?: number | null;

  @IsOptional()
  @IsArray({ message: 'فهرست مدل‌های مجاز باید آرایه باشد.' })
  @ArrayMaxSize(200, { message: 'فهرست مدل‌های مجاز حداکثر ۲۰۰ مورد است.' })
  @IsUUID('4', { each: true, message: 'شناسه مدل مجاز معتبر نیست.' })
  allowedModelIds?: string[] | null;

  @IsBoolean({ message: 'دسترسی جستجوی وب باید بولی باشد.' })
  webSearch: boolean = false;

  @IsBoolean({ message: 'دسترسی تفکر عمیق باید بولی باشد.' })
  thinking: boolean = false;

  @IsBoolean({ message: 'دسترسی پردازش فایل باید بولی باشد.' })
  fileProcessing: boolean = false;
}
