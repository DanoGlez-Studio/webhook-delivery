import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { runMigrations } from './db/migrate.js';

async function main(): Promise<void> {
  const config = loadConfig();
  await runMigrations();

  const app = await buildApp();
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`API listening on ${config.HOST}:${config.PORT}`);
}

main().catch((error) => {
  console.error('Failed to start API', error);
  process.exit(1);
});
