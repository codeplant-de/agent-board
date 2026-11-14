import { createDb, ensureAppRole, runMigrations } from './client';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const appUrl = process.env.APP_DATABASE_URL;
if (!appUrl) throw new Error('APP_DATABASE_URL is not set');
const { db, pool } = createDb(url);
await ensureAppRole(db, appUrl);
await runMigrations(db);
await pool.end();
process.stdout.write('Migrations applied\n');
