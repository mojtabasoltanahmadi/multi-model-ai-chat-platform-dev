import { IsBoolean } from 'class-validator';

export class UpdateThemeStatusDto {
  @IsBoolean({ message: 'وضعیت پوسته باید true یا false باشد.' })
  enabled: boolean;
}
