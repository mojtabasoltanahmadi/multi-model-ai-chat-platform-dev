import { IsIn } from 'class-validator';
import { SIMULATOR_SCENARIOS } from '../payment-gateway-simulator.service';

export class SimulatePaymentDto {
  @IsIn(SIMULATOR_SCENARIOS, { message: 'سناریوی شبیه‌ساز معتبر نیست.' })
  scenario: string;
}
