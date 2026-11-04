import './queueMocks.js';
import { describe, expect, it, vi } from 'vitest';
import { getPool } from '../src/db/pool.js';
import { processDeliveryJob } from '../src/services/delivery.js';
import { installIntegrationHooks, requireTestEnv } from './setup.js';

installIntegrationHooks();

describe('delivery success', () => {
  it('marks event succeeded and records latency on HTTP 200', async () => {
    requireTestEnv();
    const pool = getPool();

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO events (target_url, payload, status)
       VALUES ($1, $2::jsonb, 'pending')
       RETURNING id`,
      ['https://example.com/hooks', JSON.stringify({ orderId: 'ord_1' })],
    );
    const eventId = inserted.rows[0].id;

    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    });

    const result = await processDeliveryJob(eventId, fetchMock as typeof fetch);

    expect(result.status).toBe('succeeded');
    expect(result.attemptCount).toBe(1);

    const event = await pool.query(
      'SELECT status, attempt_count FROM events WHERE id = $1',
      [eventId],
    );
    expect(event.rows[0].status).toBe('succeeded');
    expect(Number(event.rows[0].attempt_count)).toBe(1);

    const attempts = await pool.query(
      `SELECT attempt_number, http_status, latency_ms, error_message
       FROM delivery_attempts WHERE event_id = $1`,
      [eventId],
    );
    expect(attempts.rows).toHaveLength(1);
    expect(Number(attempts.rows[0].http_status)).toBe(200);
    expect(Number(attempts.rows[0].latency_ms)).toBeGreaterThanOrEqual(0);
    expect(attempts.rows[0].error_message).toBeNull();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(headers['X-Event-Id']).toBe(eventId);
    expect(headers['Content-Type']).toBe('application/json');
  });
});
