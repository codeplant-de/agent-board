import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import type { Config } from '../config';
import { createDb, type Db } from '../db/client';
import { appRouter } from '../trpc/router';
import { testAppDatabaseUrl, testDatabaseUrl } from './global-setup';

export const testConfig: Config = {
  nodeEnv: 'test',
  port: 0,
  databaseUrl: testDatabaseUrl(),
  appDatabaseUrl: testAppDatabaseUrl(),
  publicUrl: 'https://board.test',
  allowedGroups: ['admins'],
  devAuthUser: null,
};

/** `db` is the unprivileged handle that serves requests; `admin` bypasses row-level security. The tables are wiped before each test. */
export function useTestDb(): { db: Db; admin: Db } {
  const app = createDb(testAppDatabaseUrl());
  const admin = createDb(testDatabaseUrl());
  beforeEach(async () => {
    await admin.db.execute(sql`truncate note, task, schedule, machine restart identity cascade`);
  });
  afterAll(() => Promise.all([app.pool.end(), admin.pool.end()]));
  return { db: app.db, admin: admin.db };
}

export function caller(root: Db, username = 'jascha') {
  return appRouter.createCaller({ root, config: testConfig, username });
}

export const question = {
  header: 'Scope',
  question: 'Review the migration too?',
  multiSelect: false,
  options: [
    { label: 'Yes', description: 'Include it', recommended: true },
    { label: 'No', description: 'Skip it' },
  ],
};
