import { PaymentGatewaySimulatorService } from './payment-gateway-simulator.service';
import { verifyWebhookSignature } from './webhook-signature';
import { Payment } from './payment.entity';

const payment = (overrides: Partial<Payment> = {}): Payment =>
  ({
    id: 'pay-1',
    userId: 'user-1',
    planId: 'plan-1',
    amount: '200000',
    currency: 'IRT',
    status: 'pending',
    planSnapshot: {
      planId: 'plan-1',
      planSlug: 'pro',
      planName: 'Pro',
      price: '200000',
      currency: 'IRT',
      billingPeriod: 'monthly',
    },
    trackingId: 'trk_1',
    scenario: null,
    failureReason: null,
    succeededAt: null,
    createdAt: new Date(),
    ...overrides,
  }) as Payment;

describe('PaymentGatewaySimulatorService — gateway-shaped scenarios', () => {
  let processEvent: jest.Mock;
  let configService: { get: jest.Mock };
  let service: PaymentGatewaySimulatorService;

  beforeEach(() => {
    // Stateful stand-in for the real pipeline: the same event id delivered
    // twice comes back 'duplicate' (the inbox unique constraint).
    const seen = new Set<string>();
    processEvent = jest.fn(async (event: { eventId: string; eventType: string }) => {
      if (seen.has(event.eventId)) return { status: 'duplicate' as const };
      seen.add(event.eventId);
      return { status: 'processed' as const };
    });
    configService = { get: jest.fn(() => 'sim-secret') };
    service = new PaymentGatewaySimulatorService(
      { processEvent } as never,
      configService as never,
    );
  });

  it('builds gateway events signed with the shared webhook secret', () => {
    const event = service.buildEvent(payment(), 'success');

    expect(event.eventType).toBe('payment.succeeded');
    expect(event.payload).toMatchObject({ paymentId: 'pay-1', trackingId: 'trk_1' });
    // A real gateway signs the raw body; the endpoint verifies exactly this.
    expect(verifyWebhookSignature(JSON.stringify(event.payload), event.signature, 'sim-secret')).toBe(true);
  });

  it('success/failed/cancelled dispatch exactly one event through the real pipeline', async () => {
    await service.run(payment(), 'success');
    await service.run(payment(), 'failed');
    await service.run(payment(), 'cancelled');

    const types = processEvent.mock.calls.map((call) => call[0].eventType);
    expect(types).toEqual(['payment.succeeded', 'payment.failed', 'payment.cancelled']);
  });

  it('TIMEOUT never calls the webhook — the payment stays pending', async () => {
    const result = await service.run(payment(), 'timeout');

    expect(processEvent).not.toHaveBeenCalled();
    expect(result.results).toBeUndefined();
  });

  it('duplicate_webhook delivers the SAME event id twice (the pipeline must absorb it)', async () => {
    const result = await service.run(payment(), 'duplicate_webhook');

    expect(result.results).toHaveLength(2);
    expect(result.results?.[0].status).toBe('processed');
    expect(result.results?.[1].status).toBe('duplicate');
    expect(processEvent.mock.calls[0][0].eventId).toBe(processEvent.mock.calls[1][0].eventId);
  });

  it('retry delivers success with FRESH event ids (a second activation must be ignored)', async () => {
    const result = await service.run(payment(), 'retry');

    expect(result.results).toHaveLength(2);
    expect(processEvent.mock.calls[0][0].eventId).not.toBe(processEvent.mock.calls[1][0].eventId);
  });

  it('out_of_order sends cancelled BEFORE success (late success must be ignored downstream)', async () => {
    const result = await service.run(payment(), 'out_of_order');

    const types = processEvent.mock.calls.map((call) => call[0].eventType);
    expect(types).toEqual(['payment.cancelled', 'payment.succeeded']);
    expect(result.results).toHaveLength(2);
  });

  it('unknown event types are surfaced as ignored, never applied', async () => {
    processEvent = jest.fn(async () => ({ status: 'ignored', reason: 'unknown-event-type' }));
    service = new PaymentGatewaySimulatorService({ processEvent } as never, configService as never);

    const result = await service.run(payment(), 'unknown');

    expect(result.results?.[0]).toMatchObject({ status: 'ignored' });
  });
});
