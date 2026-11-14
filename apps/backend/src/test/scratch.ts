import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APP_ROLE, createDb, migrationsFolder } from '../db/client';
import { testDatabaseUrl } from './global-setup';

/** A copy of the migrations folder that stops before the migration whose tag ends with `suffix`. */
export function migrationsBefore(suffix: string): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'board-migrations-'));
  cpSync(migrationsFolder(), folder, { recursive: true });
  const journalPath = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const stop = journal.entries.findIndex(({ tag }) => tag.endsWith(suffix));
  journal.entries = journal.entries.slice(0, stop === -1 ? undefined : stop);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

export const removeFolder = (folder: string): void => rmSync(folder, { recursive: true, force: true });

export interface ScratchDatabase {
  name: string;
  /** The admin connection URL, and the `board_app` one, of the scratch database. */
  adminUrl: string;
  appUrl: string;
  /** Drops the database (if it exists) and creates it empty. */
  recreate(): Promise<void>;
  drop(): Promise<void>;
}

/** A database named after the test database and unique per run, so two suites at once never drop each other's. */
export function scratchDatabase(label: string): ScratchDatabase {
  const base = new URL(testDatabaseUrl()).pathname.slice(1).replace(/[^A-Za-z0-9_]/g, '_');
  const name = `${base}_${label}_${randomBytes(4).toString('hex')}`;
  const urlFor = (user?: string): string => {
    const url = new URL(testDatabaseUrl());
    url.pathname = `/${name}`;
    if (user !== undefined) {
      url.username = user;
      url.password = user;
    }
    return url.toString();
  };
  const admin = createDb(testDatabaseUrl());
  const dropSql = sql.raw(`drop database if exists ${name} with (force)`);
  return {
    name,
    adminUrl: urlFor(),
    appUrl: urlFor(APP_ROLE),
    async recreate() {
      await admin.db.execute(dropSql);
      await admin.db.execute(sql.raw(`create database ${name}`));
    },
    async drop() {
      await admin.db.execute(dropSql);
      await admin.pool.end();
    },
  };
}
