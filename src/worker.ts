import { Worker } from 'bullmq';
import { loadConfig } from './config.js';
import { getRedisConnection, closeRedisConnection } from './queue/connection.js';
import {
  WEBHOOKS_QUEUE,
  type WebhookJobData,
  closeQueues,
} from './queue/queues.js';
import { processDeliveryJob } from './services/delivery.js';
import { closePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';

async function main(): Promise<void> {
  loadConfig();
  await runMigrations();

  const connection = getRedisConnection();

  const worker = new Worker<WebhookJobData>(
    WEBHOOKS_QUEUE,
    async (job) => {
      const { eventId } = job.data;
      console.log(`Processing delivery for event ${eventId}`);
      const result = await processDeliveryJob(eventId);
      console.log(
        `Event ${eventId} finished with status=${result.status} attempts=${result.attemptCount}`,
      );
      return result;
    },
    {
      connection,
      concurrency: 5,
    },
  );

  worker.on('failed', (job, error) => {
    console.error(`Job ${job?.id} failed:`, error);
  });

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed`);
  });

  console.log('Webhook delivery worker started');

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down worker...`);
    await worker.close();
    await closeQueues();
    await closeRedisConnection();
    await closePool();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error) => {
  console.error('Failed to start worker', error);
  await closeQueues();
  await closeRedisConnection();
  await closePool();
  process.exit(1);
});
