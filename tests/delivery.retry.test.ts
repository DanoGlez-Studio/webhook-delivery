import './queueMocks.js';
import { describe, expect, it, vi } from 'vitest';
import { getPool } from '../src/db/pool.js';
import { processDeliveryJob } from '../src/services/delivery.js';
import { BACKOFF_DELAYS_MS } from '../src/queue/queues.js';
import {
  enqueueWebhookMock,
  installIntegrationHooks,
  requireTestEnv,
} from './setup.js';

installIntegrationHooks();

describe('delivery retry', () => {
  it('schedules retry and increments attempt_count after HTTP 500', async () => {
    requireTestEnv();
    const pool = getPool();

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO events (target_url, payload, status)
       VALUES ($1, $2::jsonb, 'pending')
       RETURNING id`,
      ['https://example.com/hooks/fail', JSON.stringify({ fail: true })],
    );
    const eventId = inserted.rows[0].id;

    const fetchMock = vi.fn(async () =>
      new Response('upstream error', { status: 500 }),
    );

    const result = await processDeliveryJob(eventId, fetchMock as typeof fetch);

    expect(result.status).toBe('pending');
    expect(result.attemptCount).toBe(1);

    const event = await pool.query(
      `SELECT status, attempt_count, next_attempt_at
       FROM events WHERE id = $1`,
      [eventId],
    );
    expect(event.rows[0].status).toBe('pending');
    expect(Number(event.rows[0].attempt_count)).toBe(1);
    expect(event.rows[0].next_attempt_at).not.toBeNull();

    const nextAt = new Date(event.rows[0].next_attempt_at).getTime();
    const expectedMin = Date.now() + BACKOFF_DELAYS_MS[0] - 5_000;
    expect(nextAt).toBeGreaterThan(expectedMin);

    expect(enqueueWebhookMock).toHaveBeenCalledWith(
      eventId,
      BACKOFF_DELAYS_MS[0],
    );

    const attempts = await pool.query(
      `SELECT attempt_number, http_status, error_message
       FROM delivery_attempts WHERE event_id = $1`,
      [eventId],
    );
    expect(attempts.rows).toHaveLength(1);
    expect(Number(attempts.rows[0].http_status)).toBe(500);
    expect(String(attempts.rows[0].error_message)).toContain('500');
  });

  it('marks event failed without retry on HTTP 4xx', async () => {
    requireTestEnv();
    const pool = getPool();

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO events (target_url, payload, status)
       VALUES ($1, $2::jsonb, 'pending')
       RETURNING id`,
      ['https://example.com/hooks/gone', JSON.stringify({ gone: true })],
    );
    const eventId = inserted.rows[0].id;

    const fetchMock = vi.fn(async () =>
      new Response('not found', { status: 404 }),
    );

    const result = await processDeliveryJob(eventId, fetchMock as typeof fetch);

    expect(result.status).toBe('failed');
    expect(result.attemptCount).toBe(1);

    const event = await pool.query(
      'SELECT status, next_attempt_at FROM events WHERE id = $1',
      [eventId],
    );
    expect(event.rows[0].status).toBe('failed');
    expect(event.rows[0].next_attempt_at).toBeNull();
    expect(enqueueWebhookMock).not.toHaveBeenCalled();
  });
});
