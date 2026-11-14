import { cleanupAllBoards } from './cleanup';
import { loadConfig } from './config';
import { assertUnprivileged, createDb, ensureAppRole, runMigrations } from './db/client';
import { buildServer } from './server';

const config = loadConfig();

// The admin pool only prepares the database and is closed before the first request, so nothing can reach it.
const admin = createDb(config.databaseUrl, { backfillOwner: config.backfillOwner });
await ensureAppRole(admin.db, config.appDatabaseUrl);
await runMigrations(admin.db);
await admin.pool.end();

const { db, pool } = createDb(config.appDatabaseUrl);
await assertUnprivileged(db);
const app = await buildServer(config, db);

// At start and every hour, for every board.
const cleanup = () => cleanupAllBoards(db, app.log).catch((err: unknown) => app.log.error({ err }, 'cleanup failed'));
void cleanup();
setInterval(cleanup, 60 * 60_000).unref();
await app.listen({ host: '0.0.0.0', port: config.port });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
