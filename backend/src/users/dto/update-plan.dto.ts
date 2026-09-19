import { IsIn } from 'class-validator';

export class UpdatePlanDto {
  @IsIn(['free', 'premium'], {
    message: 'طرح معتبر نیست. مقادیر مجاز: free یا premium.',
  })
  plan: 'free' | 'premium';
}
