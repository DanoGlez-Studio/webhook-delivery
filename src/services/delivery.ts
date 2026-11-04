import { loadConfig } from '../config.js';
import { getPool } from '../db/pool.js';
import {
  BACKOFF_DELAYS_MS,
  MAX_AUTOMATIC_ATTEMPTS,
  delayForAttempt,
  enqueueDlq,
  enqueueWebhook,
} from '../queue/queues.js';
import {
  markProcessing,
  recordAttempt,
  updateEventAfterAttempt,
  type EventRow,
} from './events.js';
import { signPayload } from './hmac.js';

export type DeliveryResult = {
  ok: boolean;
  httpStatus: number | null;
  responseHeaders: Record<string, string> | null;
  latencyMs: number;
  errorMessage: string | null;
  permanentFailure: boolean;
};

const HTTP_TIMEOUT_MS = 10_000;

export async function deliverToTarget(
  event: EventRow,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signPayload(event.payload, secret);
  const body = JSON.stringify(event.payload);
  const started = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetchImpl(event.target_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
        'X-Event-Id': event.id,
        'X-Timestamp': timestamp,
      },
      body,
      signal: controller.signal,
    });

    const latencyMs = Date.now() - started;
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    if (response.status >= 200 && response.status < 300) {
      return {
        ok: true,
        httpStatus: response.status,
        responseHeaders,
        latencyMs,
        errorMessage: null,
        permanentFailure: false,
      };
    }

    const permanentFailure = response.status >= 400 && response.status < 500;
    return {
      ok: false,
      httpStatus: response.status,
      responseHeaders,
      latencyMs,
      errorMessage: `HTTP ${response.status}`,
      permanentFailure,
    };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message =
      error instanceof Error ? error.message : 'Unknown delivery error';
    return {
      ok: false,
      httpStatus: null,
      responseHeaders: null,
      latencyMs,
      errorMessage: message,
      permanentFailure: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function processDeliveryJob(
  eventId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: string; attemptCount: number }> {
  const config = loadConfig();
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const locked = await client.query<EventRow>(
      `SELECT * FROM events WHERE id = $1 FOR UPDATE`,
      [eventId],
    );
    const event = locked.rows[0];
    if (!event) {
      await client.query('ROLLBACK');
      throw new Error(`Event ${eventId} not found`);
    }

    if (event.status === 'succeeded') {
      await client.query('COMMIT');
      return { status: event.status, attemptCount: event.attempt_count };
    }

    const current = await markProcessing(client, eventId);
    if (!current) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to mark event ${eventId} as processing`);
    }

    const attemptNumber = current.attempt_count + 1;
    const delivery = await deliverToTarget(current, config.WEBHOOK_SECRET, fetchImpl);

    await recordAttempt(client, {
      eventId,
      attemptNumber,
      httpStatus: delivery.httpStatus,
      responseHeaders: delivery.responseHeaders,
      latencyMs: delivery.latencyMs,
      errorMessage: delivery.errorMessage,
    });

    if (delivery.ok) {
      const updated = await updateEventAfterAttempt(client, {
        eventId,
        status: 'succeeded',
        attemptCount: attemptNumber,
        nextAttemptAt: null,
      });
      await client.query('COMMIT');
      return { status: updated.status, attemptCount: updated.attempt_count };
    }

    if (delivery.permanentFailure) {
      const updated = await updateEventAfterAttempt(client, {
        eventId,
        status: 'failed',
        attemptCount: attemptNumber,
        nextAttemptAt: null,
      });
      await client.query('COMMIT');
      return { status: updated.status, attemptCount: updated.attempt_count };
    }

    const nextDelay = delayForAttempt(attemptNumber);
    if (nextDelay === null || attemptNumber >= MAX_AUTOMATIC_ATTEMPTS) {
      const updated = await updateEventAfterAttempt(client, {
        eventId,
        status: 'dead',
        attemptCount: attemptNumber,
        nextAttemptAt: null,
      });
      await client.query('COMMIT');
      await enqueueDlq(eventId);
      return { status: updated.status, attemptCount: updated.attempt_count };
    }

    const nextAttemptAt = new Date(Date.now() + nextDelay);
    const updated = await updateEventAfterAttempt(client, {
      eventId,
      status: 'pending',
      attemptCount: attemptNumber,
      nextAttemptAt,
    });
    await client.query('COMMIT');
    await enqueueWebhook(eventId, nextDelay);
    return { status: updated.status, attemptCount: updated.attempt_count };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export { BACKOFF_DELAYS_MS, MAX_AUTOMATIC_ATTEMPTS };
