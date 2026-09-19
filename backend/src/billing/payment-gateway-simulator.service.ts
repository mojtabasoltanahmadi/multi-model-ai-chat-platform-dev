import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { Payment } from './payment.entity';
import { WebhookService, WebhookProcessingResult } from './webhook.service';
import { signWebhookPayload } from './webhook-signature';

export type SimulatorScenario =
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'duplicate_webhook'
  | 'retry'
  | 'out_of_order'
  | 'unknown';

export const SIMULATOR_SCENARIOS: SimulatorScenario[] = [
  'success',
  'failed',
  'cancelled',
  'timeout',
  'duplicate_webhook',
  'retry',
  'out_of_order',
  'unknown',
];

export interface GatewayEvent {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  /** What a real gateway would send as the signature header. */
  signature: string;
}

export interface SimulatorResult {
  scenario: SimulatorScenario;
  paymentStatus: Payment['status'];
  /** Undefined = the gateway never called back (timeout). */
  results?: WebhookProcessingResult[];
}

/**
 * Payment Gateway Simulator (MVP — there is no real provider). It produces
 * gateway-shaped events signed with the shared webhook secret and feeds them
 * through the SAME processing pipeline as the HTTP webhook endpoint, so the
 * idempotency/state-machine machinery is exercised end-to-end.
 *
 * In production this service is replaced by a real gateway integration; the
 * HTTP webhook endpoint does not change.
 */
@Injectable()
export class PaymentGatewaySimulatorService {
  private readonly logger = new Logger(PaymentGatewaySimulatorService.name);

  constructor(
    private readonly webhookService: WebhookService,
    private readonly configService: ConfigService,
  ) {}

  /** Builds a signed gateway event, exactly like the provider would emit. */
  buildEvent(payment: Payment, outcome: 'success' | 'failed' | 'cancelled', eventId?: string): GatewayEvent {
    const id = eventId ?? `evt_${randomUUID()}`;
    const eventType =
      outcome === 'success' ? 'payment.succeeded' : `payment.${outcome}`;
    const payload: Record<string, unknown> = {
      paymentId: payment.id,
      trackingId: payment.trackingId,
      eventId: id,
      amount: payment.amount,
      currency: payment.currency,
      planSlug: payment.planSnapshot.planSlug,
      ...(outcome === 'failed' ? { failureReason: 'simulated-decline' } : {}),
    };
    const secret = this.configService.get<string>('billing.webhookSecret') ?? '';
    return { eventId: id, eventType, payload, signature: signWebhookPayload(JSON.stringify(payload), secret) };
  }

  /**
   * Runs a scenario against a payment. TIMEOUT produces no callback at all —
   * the payment stays pending and the user may retry or cancel.
   */
  async run(payment: Payment, scenario: SimulatorScenario): Promise<SimulatorResult> {
    this.logger.log(`SimulatorRun paymentId=${payment.id} scenario=${scenario}`);

    if (scenario === 'timeout') {
      return { scenario, paymentStatus: payment.status, results: undefined };
    }

    const results: WebhookProcessingResult[] = [];
    const dispatch = async (event: GatewayEvent) => {
      results.push(
        await this.webhookService.processEvent({
          eventId: event.eventId,
          provider: 'simulator',
          eventType: event.eventType,
          payload: event.payload,
        }),
      );
    };

    switch (scenario) {
      case 'success':
        await dispatch(this.buildEvent(payment, 'success'));
        break;
      case 'failed':
        await dispatch(this.buildEvent(payment, 'failed'));
        break;
      case 'cancelled':
        await dispatch(this.buildEvent(payment, 'cancelled'));
        break;
      case 'duplicate_webhook': {
        // Same event id delivered twice — exactly one business effect.
        const event = this.buildEvent(payment, 'success');
        await dispatch(event);
        await dispatch(event);
        break;
      }
      case 'retry': {
        // Gateway re-delivers a success with a FRESH event id: a second
        // activation must never occur if the first one already landed.
        await dispatch(this.buildEvent(payment, 'success', `evt_${randomUUID()}`));
        await dispatch(this.buildEvent(payment, 'success', `evt_${randomUUID()}`));
        break;
      }
      case 'out_of_order': {
        // Cancellation lands before the success callback — the late success
        // must be ignored, never resurrect the payment.
        await dispatch(this.buildEvent(payment, 'cancelled', `evt_${randomUUID()}`));
        await dispatch(this.buildEvent(payment, 'success', `evt_${randomUUID()}`));
        break;
      }
      case 'unknown':
        await this.webhookService.processEvent({
          eventId: `evt_${randomUUID()}`,
          provider: 'simulator',
          eventType: 'payment.undefined_event',
          payload: { paymentId: payment.id, trackingId: payment.trackingId },
        });
        results.push({ status: 'ignored', reason: 'unknown-event-type' });
        break;
    }

    return { scenario, paymentStatus: payment.status, results };
  }
}
