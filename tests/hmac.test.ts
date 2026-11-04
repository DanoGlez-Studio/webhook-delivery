import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '../src/services/hmac.js';

describe('HMAC signing', () => {
  const secret = 'test-webhook-secret';
  const payload = { hello: 'world', n: 42 };

  it('produces sha256=<hex> for a known payload', () => {
    const expectedDigest = createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex');

    const signature = signPayload(payload, secret);

    expect(signature).toBe(`sha256=${expectedDigest}`);
    expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it('verifies matching signatures and rejects mismatches', () => {
    const signature = signPayload(payload, secret);
    expect(verifySignature(payload, secret, signature)).toBe(true);
    expect(verifySignature(payload, secret, 'sha256=deadbeef')).toBe(false);
    expect(verifySignature(payload, 'other-secret', signature)).toBe(false);
  });
});
