import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { WebhookEvent } from './webhook-event.entity';
import { Payment } from './payment.entity';
import { Plan } from './plan.entity';
import { AuditEventType, AuditService } from './audit.service';
import { PaymentsService } from './payments.service';
import { SubscriptionsService } from './subscriptions.service';

export interface IncomingWebhookEvent {
  eventId: string;
  provider?: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export type WebhookProcessingResult = {
  status: 'processed' | 'duplicate' | 'ignored';
  reason?: string;
};

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === '23505';
}

function readPaymentId(payload: Record<string, unknown>): string | null {
  const paymentId = payload?.paymentId;
  return typeof paymentId === 'string' && paymentId.length > 0 ? paymentId : null;
}

/**
 * Webhook inbox + processor. Every event goes through ONE pipeline whether it
 * arrives over HTTP or from the simulator:
 *
 *   insert into inbox (unique provider+eventId)  ← INV-02 idempotency anchor
 *   → SELECT payment FOR UPDATE                  ← concurrent events serialize
 *   → apply the payment state machine
 *   → activate the subscription in the SAME transaction  ← INV-03
 *   → mark the inbox row processed
 *
 * A duplicate insert loses the race and returns 'duplicate' with zero
 * business effect (INV-04). A late event hitting a terminal payment is
 * 'ignored' (out-of-order safety). Unexpected business errors roll the whole
 * transaction back so the gateway can retry cleanly.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);

  constructor(
    @InjectRepository(WebhookEvent)
    private readonly webhookEventsRepository: Repository<WebhookEvent>,
    private readonly paymentsService: PaymentsService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly auditService: AuditService,
  ) {}

  async processEvent(event: IncomingWebhookEvent): Promise<WebhookProcessingResult> {
    const provider = event.provider ?? 'simulator';
    await this.auditService.record(AuditEventType.WEBHOOK_RECEIVED, {
      target: `webhook:${event.eventId}`,
      correlationId: event.eventId,
      metadata: { eventType: event.eventType, provider },
    });

    const result = await this.webhookEventsRepository.manager.transaction(async (manager) =>
      this.processInTransaction(manager, event, provider),
    );

    if (result.status === 'duplicate') {
      await this.auditService.record(AuditEventType.WEBHOOK_DUPLICATE, {
        target: `webhook:${event.eventId}`,
        correlationId: event.eventId,
        metadata: { eventType: event.eventType, provider },
      });
      this.logger.log(`WebhookDuplicate eventId=${event.eventId}`);
    } else if (result.status === 'ignored') {
      await this.auditService.record(AuditEventType.WEBHOOK_IGNORED, {
        target: `webhook:${event.eventId}`,
        correlationId: event.eventId,
        metadata: { eventType: event.eventType, reason: result.reason ?? null },
      });
    }
    return result;
  }

  private async processInTransaction(
    manager: EntityManager,
    event: IncomingWebhookEvent,
    provider: string,
  ): Promise<WebhookProcessingResult> {
    const eventRepo = manager.getRepository(WebhookEvent);

    try {
      await eventRepo.save(
        eventRepo.create({
          eventId: event.eventId,
          provider,
          eventType: event.eventType,
          payload: event.payload,
          status: 'received',
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { status: 'duplicate' };
      }
      throw error;
    }

    const finish = async (status: 'processed' | 'ignored', reason?: string) => {
      const stored = await eventRepo.findOne({ where: { eventId: event.eventId, provider } });
      if (stored) {
        stored.status = status;
        stored.ignoreReason = reason ?? null;
        stored.processedAt = new Date();
        await eventRepo.save(stored);
      }
      return { status, reason };
    };

    const paymentId = readPaymentId(event.payload);
    if (!paymentId) {
      return finish('ignored', 'missing-payment-reference');
    }
    const payment = await manager.getRepository(Payment).findOne({
      where: { id: paymentId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!payment) {
      return finish('ignored', 'payment-not-found');
    }

    switch (event.eventType) {
      case 'payment.succeeded': {
        if (payment.status !== 'pending') {
          return finish('ignored', `payment-already-${payment.status}`);
        }
        await this.paymentsService.transitionInTransaction(manager, payment.id, 'success', {
          scenario: 'webhook',
        });
        const plan = await manager.getRepository(Plan).findOne({ where: { id: payment.planId } });
        if (!plan) {
          // Rolls back the whole transaction — the gateway will retry.
          throw new Error(`Plan row missing for payment ${payment.id}`);
        }
        await this.subscriptionsService.activateInTransaction(
          manager,
          payment.userId,
          plan,
          payment.id,
        );
        await this.auditService.record(
          AuditEventType.PAYMENT_SUCCEEDED,
          {
            actorId: payment.userId,
            target: `payment:${payment.id}`,
            correlationId: event.eventId,
            metadata: { userId: payment.userId, planSlug: payment.planSnapshot.planSlug },
          },
          manager,
        );
        this.logger.log(`WebhookProcessed eventId=${event.eventId} paymentId=${payment.id} effect=activated`);
        return finish('processed');
      }
      case 'payment.failed': {
        if (payment.status !== 'pending') {
          return finish('ignored', `payment-already-${payment.status}`);
        }
        await this.paymentsService.transitionInTransaction(manager, payment.id, 'failed', {
          failureReason:
            typeof event.payload?.failureReason === 'string'
              ? event.payload.failureReason
              : 'gateway-reported-failure',
          scenario: 'webhook',
        });
        await this.auditService.record(
          AuditEventType.PAYMENT_FAILED,
          {
            actorId: payment.userId,
            target: `payment:${payment.id}`,
            correlationId: event.eventId,
            metadata: { userId: payment.userId },
          },
          manager,
        );
        return finish('processed');
      }
      case 'payment.cancelled': {
        if (payment.status !== 'pending') {
          return finish('ignored', `payment-already-${payment.status}`);
        }
        await this.paymentsService.transitionInTransaction(manager, payment.id, 'cancelled', {
          scenario: 'webhook',
        });
        await this.auditService.record(
          AuditEventType.PAYMENT_CANCELLED,
          {
            actorId: payment.userId,
            target: `payment:${payment.id}`,
            correlationId: event.eventId,
            metadata: { userId: payment.userId },
          },
          manager,
        );
        return finish('processed');
      }
      default:
        // Unknown event types are acknowledged but never applied — the
        // gateway must not keep retrying them either.
        return finish('ignored', 'unknown-event-type');
    }
  }
}
