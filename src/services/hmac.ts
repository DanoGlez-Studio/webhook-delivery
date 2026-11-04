import { createHmac, timingSafeEqual } from 'node:crypto';

export function signPayload(payload: unknown, secret: string): string {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${digest}`;
}

export function verifySignature(
  payload: unknown,
  secret: string,
  signatureHeader: string,
): boolean {
  const expected = signPayload(payload, secret);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);

  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, actualBuf);
}
