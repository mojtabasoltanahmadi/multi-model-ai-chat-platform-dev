import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { Plan } from './plan.entity';
import { Subscription } from './subscription.entity';
import { Payment } from './payment.entity';
import { WebhookEvent } from './webhook-event.entity';
import { AuditLog } from './audit-log.entity';
import { BillingController } from './billing.controller';
import { BillingWebhookController } from './billing-webhook.controller';
import { AdminBillingController } from './admin-billing.controller';
import { PlansService } from './plans.service';
import { PaymentsService } from './payments.service';
import { SubscriptionsService } from './subscriptions.service';
import { EntitlementsService } from './entitlements.service';
import { WebhookService } from './webhook.service';
import { AuditService } from './audit.service';
import { PaymentGatewaySimulatorService } from './payment-gateway-simulator.service';

/**
 * Commercialization subsystem: plans, payments (gateway simulator),
 * subscriptions, entitlements and the audit trail. EntitlementsService is
 * the single access-policy chokepoint consumed by the chat flow and the
 * usage snapshot.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Plan, Subscription, Payment, WebhookEvent, AuditLog]),
    UsersModule,
  ],
  controllers: [BillingController, BillingWebhookController, AdminBillingController],
  providers: [
    PlansService,
    PaymentsService,
    SubscriptionsService,
    EntitlementsService,
    WebhookService,
    AuditService,
    PaymentGatewaySimulatorService,
  ],
  exports: [EntitlementsService, PaymentsService, SubscriptionsService, AuditService],
})
export class BillingModule {}
