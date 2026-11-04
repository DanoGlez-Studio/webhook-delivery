import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { newDb, type IMemoryDb } from 'pg-mem';
import { resetConfigCache } from '../src/config.js';
import { closePool, setPool } from '../src/db/pool.js';
import { enqueueDlqMock, enqueueWebhookMock } from './queueMocks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let memoryDb: IMemoryDb | null = null;

export function requireTestEnv(): void {
  process.env.DATABASE_URL ??=
    'postgresql://webhook:webhook@localhost:5432/webhook_delivery';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.WEBHOOK_SECRET ??= 'test-webhook-secret';
  process.env.NODE_ENV = 'test';
  resetConfigCache();
}

async function applySchema(db: IMemoryDb): Promise<void> {
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => randomUUID(),
    impure: true,
  });

  const migrationPath = path.join(
    __dirname,
    '../src/db/migrations/001_init.sql',
  );
  const sql = (await readFile(migrationPath, 'utf8')).replace(
    /CREATE EXTENSION[^;]+;/gi,
    '',
  );
  db.public.none(sql);
}

export async function resetDatabase(): Promise<void> {
  if (!memoryDb) {
    throw new Error('Memory database is not initialized');
  }
  memoryDb.public.none('DELETE FROM delivery_attempts');
  memoryDb.public.none('DELETE FROM events');
  enqueueWebhookMock.mockClear();
  enqueueDlqMock.mockClear();
}

export function installIntegrationHooks(): void {
  beforeAll(async () => {
    requireTestEnv();
    memoryDb = newDb({ autoCreateForeignKeyIndices: true });
    await applySchema(memoryDb);
    const { Pool } = memoryDb.adapters.createPg();
    setPool(new Pool());
  });

  beforeEach(async () => {
    requireTestEnv();
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
    setPool(null);
    memoryDb = null;
  });
}

export { enqueueWebhookMock, enqueueDlqMock };
