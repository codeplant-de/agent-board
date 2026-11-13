import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { buildServer } from './server';

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl);

await runMigrations(db);
const app = await buildServer(config, db);
await app.listen({ host: '0.0.0.0', port: config.port });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
