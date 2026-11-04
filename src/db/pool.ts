import pg from 'pg';
import { loadConfig } from '../config.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function setPool(next: pg.Pool | null): void {
  pool = next;
}

export function getPool(): pg.Pool {
  if (!pool) {
    const config = loadConfig();
    pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
