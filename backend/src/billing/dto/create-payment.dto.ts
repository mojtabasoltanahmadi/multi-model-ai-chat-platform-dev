import { IsUUID } from 'class-validator';

export class CreatePaymentDto {
  @IsUUID('4', { message: 'شناسه طرح معتبر نیست.' })
  planId: string;
}
