import { verifyWebhookSignature, signWebhookPayload, WEBHOOK_SIGNATURE_HEADER } from './webhook-signature';

describe('webhook signature (HMAC-SHA256)', () => {
  const secret = 'test-secret';
  const body = JSON.stringify({ eventId: 'evt-1', paymentId: 'pay-1' });

  it('signs and verifies a payload round-trip', () => {
    const signature = signWebhookPayload(body, secret);
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true);
  });

  it('rejects a FORGED webhook: tampered body, wrong secret, or missing signature', () => {
    const signature = signWebhookPayload(body, secret);
    expect(verifyWebhookSignature(body + ' ', signature, secret)).toBe(false);
    expect(verifyWebhookSignature(body, signature, 'other-secret')).toBe(false);
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
  });

  it('exposes the header name the controller reads', () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-hooshyar-signature');
  });
});
