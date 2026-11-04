import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';

let connection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!connection) {
    const config = loadConfig();
    connection = new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: null,
    });
  }
  return connection;
}

export async function closeRedisConnection(): Promise<void> {
  if (connection) {
    await connection.quit();
    connection = null;
  }
}
