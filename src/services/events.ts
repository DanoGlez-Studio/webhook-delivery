import type { PoolClient } from 'pg';
import { getPool } from '../db/pool.js';
import { enqueueWebhook } from '../queue/queues.js';

export type EventStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'dead';

export type EventRow = {
  id: string;
  idempotency_key: string | null;
  target_url: string;
  payload: unknown;
  status: EventStatus;
  attempt_count: number;
  next_attempt_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type DeliveryAttemptRow = {
  id: string;
  event_id: string;
  attempt_number: number;
  http_status: number | null;
  response_headers: Record<string, string> | null;
  latency_ms: number | null;
  error_message: string | null;
  created_at: Date;
};

export type CreateEventInput = {
  targetUrl: string;
  payload: unknown;
  idempotencyKey?: string;
};

export async function createEvent(
  input: CreateEventInput,
): Promise<{ event: EventRow; created: boolean }> {
  const pool = getPool();

  if (input.idempotencyKey) {
    const existing = await pool.query<EventRow>(
      'SELECT * FROM events WHERE idempotency_key = $1',
      [input.idempotencyKey],
    );
    if (existing.rows[0]) {
      return { event: existing.rows[0], created: false };
    }
  }

  const inserted = await pool.query<EventRow>(
    `INSERT INTO events (idempotency_key, target_url, payload, status)
     VALUES ($1, $2, $3::jsonb, 'pending')
     RETURNING *`,
    [
      input.idempotencyKey ?? null,
      input.targetUrl,
      JSON.stringify(input.payload),
    ],
  );

  const event = inserted.rows[0];
  await enqueueWebhook(event.id);
  return { event, created: true };
}

export async function listEvents(limit = 50, offset = 0): Promise<{
  events: Array<EventRow & { last_attempt: DeliveryAttemptRow | null }>;
  total: number;
}> {
  const pool = getPool();
  const countResult = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM events',
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const result = await pool.query<EventRow>(
    `SELECT * FROM events
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  const events = await Promise.all(
    result.rows.map(async (event) => {
      const last = await pool.query<DeliveryAttemptRow>(
        `SELECT * FROM delivery_attempts
         WHERE event_id = $1
         ORDER BY attempt_number DESC
         LIMIT 1`,
        [event.id],
      );
      return {
        ...event,
        last_attempt: last.rows[0] ?? null,
      };
    }),
  );

  return { events, total };
}

export async function getEventById(id: string): Promise<{
  event: EventRow;
  attempts: DeliveryAttemptRow[];
} | null> {
  const pool = getPool();
  const eventResult = await pool.query<EventRow>(
    'SELECT * FROM events WHERE id = $1',
    [id],
  );
  const event = eventResult.rows[0];
  if (!event) {
    return null;
  }

  const attemptsResult = await pool.query<DeliveryAttemptRow>(
    `SELECT * FROM delivery_attempts
     WHERE event_id = $1
     ORDER BY attempt_number ASC`,
    [id],
  );

  return { event, attempts: attemptsResult.rows };
}

export async function retryEvent(id: string): Promise<EventRow | null> {
  const pool = getPool();
  const result = await pool.query<EventRow>(
    `UPDATE events
     SET status = 'pending',
         next_attempt_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id],
  );

  const event = result.rows[0];
  if (!event) {
    return null;
  }

  await enqueueWebhook(event.id);
  return event;
}

export async function markProcessing(
  client: PoolClient,
  eventId: string,
): Promise<EventRow | null> {
  const result = await client.query<EventRow>(
    `UPDATE events
     SET status = 'processing', updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [eventId],
  );
  return result.rows[0] ?? null;
}

export async function recordAttempt(
  client: PoolClient,
  input: {
    eventId: string;
    attemptNumber: number;
    httpStatus: number | null;
    responseHeaders: Record<string, string> | null;
    latencyMs: number | null;
    errorMessage: string | null;
  },
): Promise<DeliveryAttemptRow> {
  const result = await client.query<DeliveryAttemptRow>(
    `INSERT INTO delivery_attempts
       (event_id, attempt_number, http_status, response_headers, latency_ms, error_message)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     RETURNING *`,
    [
      input.eventId,
      input.attemptNumber,
      input.httpStatus,
      input.responseHeaders ? JSON.stringify(input.responseHeaders) : null,
      input.latencyMs,
      input.errorMessage,
    ],
  );
  return result.rows[0];
}

export async function updateEventAfterAttempt(
  client: PoolClient,
  input: {
    eventId: string;
    status: EventStatus;
    attemptCount: number;
    nextAttemptAt: Date | null;
  },
): Promise<EventRow> {
  const result = await client.query<EventRow>(
    `UPDATE events
     SET status = $2,
         attempt_count = $3,
         next_attempt_at = $4,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [input.eventId, input.status, input.attemptCount, input.nextAttemptAt],
  );
  return result.rows[0];
}
