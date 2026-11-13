import { sql } from 'drizzle-orm';
import { createDb, runMigrations } from '../db/client';

export const testDatabaseUrl = (): string =>
  process.env.TEST_DATABASE_URL ?? 'postgresql://board:board@localhost:54331/board_test';

/** Fresh schema for every test run, then all migrations. */
export default async function setup() {
  const { db, pool } = createDb(testDatabaseUrl());
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  await pool.end();
}
