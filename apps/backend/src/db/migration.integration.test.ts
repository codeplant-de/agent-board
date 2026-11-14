import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test/global-setup';
import { createDb, migrationsFolder, runMigrations, type Db } from './client';

// Named after the test database and unique per run, so two suites at once never drop each other's scratch database.
const SCRATCH = `${new URL(testDatabaseUrl()).pathname.slice(1).replace(/[^A-Za-z0-9_]/g, '_')}_migration_${randomBytes(4).toString('hex')}`;

const scratchUrl = (): string => {
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${SCRATCH}`;
  return url.toString();
};

/** The pool of a scratch database that the test later drops by force: a connection it kills is no failure. */
function scratchDb(options: { backfillOwner?: string } = {}): ReturnType<typeof createDb> {
  const scratch = createDb(scratchUrl(), options);
  scratch.pool.on('error', () => undefined);
  return scratch;
}

/** A copy of the migrations folder that stops before the migration whose tag ends with `suffix`. */
function foldersBefore(suffix: string): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'board-migrations-'));
  cpSync(migrationsFolder(), folder, { recursive: true });
  const journalPath = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  journal.entries = journal.entries.slice(
    0,
    journal.entries.findIndex(({ tag }) => tag.endsWith(suffix)),
  );
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
    folder ??= foldersBefore('_tenancy');
    old = scratchDb();
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
    const run = scratchDb();
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
    const run = scratchDb({ backfillOwner: owner });
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

describe('the encrypted content migration on a database that already has rows', () => {
  const admin = createDb(testDatabaseUrl());
  let old: ReturnType<typeof createDb>;
  let folder: string;
  const questions = [
    { header: 'Scope', question: 'Q?', multiSelect: false, options: [{ label: 'A', description: '' }] },
  ];

  beforeEach(async () => {
    if (old) await old.pool.end();
    await admin.db.execute(sql.raw(`drop database if exists ${SCRATCH} with (force)`));
    await admin.db.execute(sql.raw(`create database ${SCRATCH}`));
    folder ??= foldersBefore('_encrypted_content');
    old = scratchDb();
    await migrate(old.db, { migrationsFolder: folder });
    await old.db.execute(sql`insert into app_user (username) values ('alice')`);
    await old.db.execute(
      sql`insert into task (owner, id, title, input, position, labels) values ('alice', 't1', 'old', 'x', 0, '{review-pr}')`,
    );
    await old.db.execute(sql`
      insert into note (owner, id, task_id, author, kind, body, questions, answers)
      values ('alice', 'n1', 't1', 'agent', 'question', '', ${JSON.stringify(questions)}::jsonb, null),
             ('alice', 'n2', 't1', 'user', 'answer', 'thanks', null, '[{"selected":["A"],"other":"é"}]'::jsonb),
             ('alice', 'n3', 't1', 'system', 'event', 'Marked done.', null, null)`);
    await old.db.execute(
      sql`insert into transcript_run (owner, id, task_id, machine, started_at, last_event_at) values ('alice', 'r1', 't1', 'laptop', now(), now())`,
    );
    await old.db.execute(
      sql`insert into transcript_event (owner, run_id, seq, at, kind, data) values ('alice', 'r1', 0, now(), 'text', ${JSON.stringify({ kind: 'text', text: 'hi "there"' })}::jsonb)`,
    );
  });

  afterAll(async () => {
    await old.pool.end();
    await admin.db.execute(sql.raw(`drop database if exists ${SCRATCH} with (force)`));
    await admin.pool.end();
    rmSync(folder, { recursive: true, force: true });
  });

  const columnType = async (table: string, column: string) =>
    (
      await old.db.execute<{ data_type: string }>(
        sql`select data_type from information_schema.columns where table_name = ${table} and column_name = ${column}`,
      )
    ).rows[0]?.data_type;

  it('keeps questions, answers and event data as their JSON text, adds the preview and drops the labels', async () => {
    expect(await columnType('note', 'questions')).toBe('jsonb');
    await runMigrations(old.db);
    for (const [table, column] of [
      ['note', 'questions'],
      ['note', 'answers'],
      ['transcript_event', 'data'],
      ['note', 'preview'],
    ] as const)
      expect(await columnType(table, column), `${table}.${column}`).toBe('text');
    expect(await columnType('task', 'labels')).toBeUndefined();

    const { rows } = await old.db.execute<{
      id: string;
      questions: string | null;
      answers: string | null;
      preview: string | null;
    }>(sql`select id, questions, answers, preview from note order by id`);
    expect(
      rows.map((r) => [
        r.id,
        r.questions === null ? null : JSON.parse(r.questions),
        r.answers === null ? null : JSON.parse(r.answers),
        r.preview,
      ]),
    ).toEqual([
      ['n1', questions, null, null],
      ['n2', null, [{ selected: ['A'], other: 'é' }], null],
      ['n3', null, null, null],
    ]);
    const event = await old.db.execute<{ data: string }>(sql`select data from transcript_event`);
    expect(JSON.parse(event.rows[0]!.data)).toEqual({ kind: 'text', text: 'hi "there"' });
    const task = await old.db.execute<{ title: string; input: string }>(sql`select title, input from task`);
    expect(task.rows).toEqual([{ title: 'old', input: 'x' }]);
  });

  it('accepts the author "server" afterwards', async () => {
    await runMigrations(old.db);
    await old.db.execute(
      sql`insert into note (owner, id, task_id, author, kind, body) values ('alice', 'n4', 't1', 'server', 'event', 'Marked done.')`,
    );
    const { rows } = await old.db.execute<{ author: string }>(sql`select author from note where id = 'n4'`);
    expect(rows).toEqual([{ author: 'server' }]);
  });
});
