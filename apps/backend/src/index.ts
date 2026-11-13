import { loadConfig } from './config';
import { createDb, runMigrations } from './db/client';
import { buildServer } from './server';
import { deleteOldTranscripts } from './services/transcripts';

const config = loadConfig();
const { db, pool } = createDb(config.databaseUrl);

await runMigrations(db);
const app = await buildServer(config, db);

// Transcripts of tasks closed more than 14 days ago go, at start and every hour.
const cleanup = () =>
  deleteOldTranscripts(db)
    .then((count) => count > 0 && app.log.info(`deleted ${count} old transcript runs`))
    .catch((err: unknown) => app.log.error({ err }, 'transcript cleanup failed'));
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
