import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import type { Config } from '../config';
import { createDb, type Db } from '../db/client';
import { appRouter } from '../trpc/router';
import { testDatabaseUrl } from './global-setup';

export const testConfig: Config = {
  nodeEnv: 'test',
  port: 0,
  databaseUrl: testDatabaseUrl(),
  publicUrl: 'https://board.test',
  allowedGroups: ['admins'],
  devAuthUser: null,
};

/** A database handle shared by the file, wiped before each test. */
export function useTestDb(): { db: Db } {
  const handle = createDb(testDatabaseUrl());
  beforeEach(async () => {
    await handle.db.execute(sql`truncate note, task, label, machine restart identity cascade`);
    await handle.db.execute(sql`insert into label (name) values ('review-pr'), ('research')`);
  });
  afterAll(() => handle.pool.end());
  return { db: handle.db };
}

export function caller(db: Db, username = 'jascha') {
  return appRouter.createCaller({ db, config: testConfig, username });
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
