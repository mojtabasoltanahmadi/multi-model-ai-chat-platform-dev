import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PlansService } from './plans.service';
import { PaymentsService, UserPayment } from './payments.service';
import { SubscriptionsService } from './subscriptions.service';
import { EntitlementsService } from './entitlements.service';
import {
  PaymentGatewaySimulatorService,
  SimulatorResult,
} from './payment-gateway-simulator.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { SimulatePaymentDto } from './dto/simulate-payment.dto';
import { Payment } from './payment.entity';

interface AuthUser {
  id: string;
  email: string;
  role: string;
}

/**
 * User-facing billing endpoints. Everything here derives access from the
 * database (INV-05); the UI only displays what these endpoints return.
 */
@Controller('billing')
export class BillingController {
  constructor(
    private readonly plansService: PlansService,
    private readonly paymentsService: PaymentsService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly entitlementsService: EntitlementsService,
    private readonly simulatorService: PaymentGatewaySimulatorService,
  ) {}

  @Get('plans')
  listPlans() {
    return this.plansService.listActive();
  }

  @Get('subscription/me')
  async mySubscription(@CurrentUser() user: AuthUser) {
    const { snapshot, subscription } = await this.entitlementsService.resolveWithSubscription(user.id);
    return { entitlements: snapshot, subscription };
  }

  @Post('subscription/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelSubscription(@CurrentUser() user: AuthUser) {
    const { snapshot, subscription } = await this.entitlementsService.resolveWithSubscription(user.id);
    if (!subscription) {
      // Keep the free tier in sync in case an expiry was just processed.
      return { entitlements: snapshot, subscription: null };
    }
    await this.subscriptionsService.cancel(subscription.id, user.id, user.email);
    const next = await this.entitlementsService.resolveWithSubscription(user.id);
    return { entitlements: next.snapshot, subscription: next.subscription };
  }

  @Post('payments')
  async createPayment(@CurrentUser() user: AuthUser, @Body() dto: CreatePaymentDto) {
    const payment = await this.paymentsService.create(user.id, dto.planId, user.email);
    return this.paymentsService.toUserPayment(payment);
  }

  @Get('payments')
  async myPayments(@CurrentUser() user: AuthUser): Promise<UserPayment[]> {
    const payments = await this.paymentsService.listForUser(user.id);
    return payments.map((payment) => this.paymentsService.toUserPayment(payment));
  }

  @Get('payments/:paymentId')
  async myPayment(
    @CurrentUser() user: AuthUser,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<UserPayment> {
    const payment = await this.paymentsService.getOwned(user.id, paymentId);
    return this.paymentsService.toUserPayment(payment);
  }

  @Post('payments/:paymentId/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelPayment(
    @CurrentUser() user: AuthUser,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ): Promise<UserPayment> {
    const payment = await this.paymentsService.cancelPending(user.id, paymentId, user.email);
    return this.paymentsService.toUserPayment(payment);
  }

  /**
   * MVP-only gateway simulator: applies a scenario to a PENDING payment and
   * runs the resulting webhook(s) through the production pipeline. Replaced
   * by a real gateway integration later; the webhook contract stays.
   */
  @Post('payments/:paymentId/simulate')
  @HttpCode(HttpStatus.OK)
  async simulate(
    @CurrentUser() user: AuthUser,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: SimulatePaymentDto,
  ): Promise<{ scenario: string; payment: UserPayment; results: SimulatorResult['results'] | null }> {
    const payment: Payment = await this.paymentsService.getOwned(user.id, paymentId);
    const result = await this.simulatorService.run(payment, dto.scenario as never);
    const fresh = await this.paymentsService.getOwned(user.id, paymentId);
    return {
      scenario: result.scenario,
      payment: this.paymentsService.toUserPayment(fresh),
      results: result.results ?? null,
    };
  }
}
