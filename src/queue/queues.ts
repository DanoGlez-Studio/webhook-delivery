import { Queue } from 'bullmq';
import { getRedisConnection } from './connection.js';

export const WEBHOOKS_QUEUE = 'webhooks';
export const WEBHOOKS_DLQ = 'webhooks-dlq';

export type WebhookJobData = {
  eventId: string;
};

let webhooksQueue: Queue<WebhookJobData> | null = null;
let dlqQueue: Queue<WebhookJobData> | null = null;

/** Fixed portfolio backoff between attempts: 30s → 2m → 10m → 1h */
export const BACKOFF_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  60 * 60_000,
] as const;

/** Initial attempt + one retry per backoff delay */
export const MAX_AUTOMATIC_ATTEMPTS = BACKOFF_DELAYS_MS.length + 1;

export function getWebhooksQueue(): Queue<WebhookJobData> {
  if (!webhooksQueue) {
    webhooksQueue = new Queue<WebhookJobData>(WEBHOOKS_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return webhooksQueue;
}

export function getDlqQueue(): Queue<WebhookJobData> {
  if (!dlqQueue) {
    dlqQueue = new Queue<WebhookJobData>(WEBHOOKS_DLQ, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    });
  }
  return dlqQueue;
}

export async function enqueueWebhook(
  eventId: string,
  delayMs = 0,
): Promise<void> {
  const queue = getWebhooksQueue();
  await queue.add(
    'deliver',
    { eventId },
    {
      jobId: `${eventId}:${Date.now()}:${delayMs}`,
      delay: delayMs > 0 ? delayMs : undefined,
    },
  );
}

export async function enqueueDlq(eventId: string): Promise<void> {
  const queue = getDlqQueue();
  await queue.add(
    'dead',
    { eventId },
    {
      jobId: `dlq-${eventId}-${Date.now()}`,
    },
  );
}

export async function closeQueues(): Promise<void> {
  const closers: Promise<void>[] = [];
  if (webhooksQueue) {
    closers.push(webhooksQueue.close());
    webhooksQueue = null;
  }
  if (dlqQueue) {
    closers.push(dlqQueue.close());
    dlqQueue = null;
  }
  await Promise.all(closers);
}

export function delayForAttempt(attemptNumber: number): number | null {
  // attemptNumber is 1-based after a failed delivery; next delay index is attemptNumber - 1
  const index = attemptNumber - 1;
  if (index < 0 || index >= BACKOFF_DELAYS_MS.length) {
    return null;
  }
  return BACKOFF_DELAYS_MS[index];
}
