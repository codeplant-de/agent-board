import { loadConfig } from './config';
import { assertUnprivileged, createDb, ensureAppRole, runMigrations } from './db/client';
import { buildServer } from './server';
import { archiveStaleDone } from './services/tasks';
import { deleteOldTranscripts } from './services/transcripts';

const config = loadConfig();

// The admin pool only prepares the database and is closed before the first request, so nothing can reach it.
const admin = createDb(config.databaseUrl);
await ensureAppRole(admin.db, config.appDatabaseUrl);
await runMigrations(admin.db);
await admin.pool.end();

const { db, pool } = createDb(config.appDatabaseUrl);
await assertUnprivileged(db);
const app = await buildServer(config, db);

// At start and every hour: tasks untouched in Done for 14 days are closed, and the transcripts of tasks closed 14 days ago go.
const cleanup = () =>
  archiveStaleDone(db)
    .then((count) => count > 0 && app.log.info(`closed ${count} old done tasks`))
    .then(() => deleteOldTranscripts(db))
    .then((count) => count > 0 && app.log.info(`deleted ${count} old transcript runs`))
    .catch((err: unknown) => app.log.error({ err }, 'cleanup failed'));
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
