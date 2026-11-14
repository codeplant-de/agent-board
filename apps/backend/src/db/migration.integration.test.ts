import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test/global-setup';
import { createDb, migrationsFolder, runMigrations, type Db } from './client';

const SCRATCH = 'board_migration_scratch';

const scratchUrl = (): string => {
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${SCRATCH}`;
  return url.toString();
};

/** A copy of the migrations folder that stops before the tenancy migration. */
function foldersBeforeTenancy(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'board-migrations-'));
  cpSync(migrationsFolder(), folder, { recursive: true });
  const journalPath = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.filter(({ tag }) => !tag.endsWith('_tenancy'));
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

describe('the tenancy migration on a database that already has rows', () => {
  const admin = createDb(testDatabaseUrl());
  let old: ReturnType<typeof createDb>;
  let folder: string;

  beforeEach(async () => {
    if (old) await old.pool.end();
    await admin.db.execute(sql.raw(`drop database if exists ${SCRATCH} with (force)`));
    await admin.db.execute(sql.raw(`create database ${SCRATCH}`));
    folder ??= foldersBeforeTenancy();
    old = createDb(scratchUrl());
    await migrate(old.db, { migrationsFolder: folder });
    await old.db.execute(sql`insert into task (id, title, input, position) values ('t1', 'old', 'x', 0)`);
    await old.db.execute(sql`insert into note (id, task_id, author, kind) values ('n1', 't1', 'user', 'comment')`);
    await old.db.execute(sql`insert into machine (name, token_hash) values ('laptop', 'h')`);
    await old.db.execute(
      sql`insert into transcript_run (id, task_id, machine, started_at, last_event_at) values ('r1', 't1', 'laptop', now(), now())`,
    );
    await old.db.execute(
      sql`insert into transcript_event (run_id, seq, at, kind, data) values ('r1', 0, now(), 'text', '{}')`,
    );
  });

  afterAll(async () => {
    await old.pool.end();
    await admin.db.execute(sql.raw(`drop database if exists ${SCRATCH} with (force)`));
    await admin.pool.end();
    rmSync(folder, { recursive: true, force: true });
  });

  const owners = async (db: Db, table: string) =>
    (await db.execute<{ owner: string }>(sql`select owner from ${sql.identifier(table)}`)).rows.map((r) => r.owner);

  it('fails and changes nothing without BACKFILL_OWNER', async () => {
    const run = createDb(scratchUrl());
    try {
      await expect(runMigrations(run.db)).rejects.toThrow(/BACKFILL_OWNER/);
      const { rows } = await run.db.execute(
        sql`select 1 from information_schema.columns where table_name = 'task' and column_name = 'owner'`,
      );
      expect(rows).toEqual([]);
    } finally {
      await run.pool.end();
    }
  });

  it.each(['alice', 'corp\\jane', 'jane doe'])('gives every existing row to BACKFILL_OWNER %j', async (owner) => {
    const run = createDb(scratchUrl(), { backfillOwner: owner });
    try {
      await runMigrations(run.db);
      for (const table of ['task', 'note', 'machine', 'transcript_run', 'transcript_event'])
        expect(await owners(run.db, table), table).toEqual([owner]);
      const users = await run.db.execute<{ username: string }>(sql`select username from app_user`);
      expect(users.rows).toEqual([{ username: owner }]);
    } finally {
      await run.pool.end();
    }
  });
});
