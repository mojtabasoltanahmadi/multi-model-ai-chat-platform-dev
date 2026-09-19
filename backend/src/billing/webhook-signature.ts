import { createHmac, timingSafeEqual } from 'crypto';

/**
 * HMAC-SHA256 signature scheme shared by the webhook endpoint and the
 * payment gateway simulator. The simulator signs exactly like a real
 * gateway would, so the endpoint's verification path is production-shaped.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'x-hooshyar-signature';

export function signWebhookPayload(rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** Constant-time comparison; missing/tampered signatures never match. */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signWebhookPayload(rawBody, secret), 'utf8');
  const provided = Buffer.from(signature, 'utf8');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}
