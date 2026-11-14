import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction; services accept either. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export function createDb(databaseUrl: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return { db: drizzle({ client: pool, schema }), pool };
}

/**
 * Migrations live in apps/backend/drizzle. In the bundled build (dist/index.js) the folder is
 * copied next to dist, so resolve relative to this module in both cases.
 */
export function migrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return path.resolve(process.env.MIGRATIONS_DIR);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, here.endsWith('dist') ? '../drizzle' : '../../drizzle');
}

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: migrationsFolder() });
}

/** The login role that serves requests; the grants in migration 0010 name it. */
export const APP_ROLE = 'board_app';

/**
 * Creates the request role named by `appUrl` with that URL's password, or resets the password of an existing one.
 * Created NOSUPERUSER NOBYPASSRLS; an existing role only gets its password reset, because Postgres 16 refuses even a no-op NOSUPERUSER from a non-superuser (`assertUnprivileged` guards the rest). Run as the admin user, before migrations.
 */
export async function ensureAppRole(adminDb: Db, appUrl: string): Promise<void> {
  const url = new URL(appUrl);
  const role = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (role !== APP_ROLE) throw new Error(`APP_DATABASE_URL must connect as ${APP_ROLE}, not "${role}"`);
  if (!password) throw new Error('APP_DATABASE_URL needs a password');
  const { rows: admin } = await adminDb.execute<{ name: string }>(sql`select current_user as name`);
  if (admin[0]?.name === role) throw new Error('APP_DATABASE_URL must use a different user than DATABASE_URL');
  const { rows } = await adminDb.execute<{ ddl: string }>(sql`
    select case when exists (select 1 from pg_roles where rolname = ${role}::text)
      then format('alter role %I with login password %L', ${role}::text, ${password}::text)
      else format('create role %I with login nosuperuser nobypassrls nocreatedb nocreaterole password %L', ${role}::text, ${password}::text)
    end as ddl`);
  await adminDb.execute(sql.raw(rows[0]!.ddl));
}

/** Refuses a connection that would bypass row-level security: a superuser, BYPASSRLS, or the owner of (or a member of the role owning) a table in public. */
export async function assertUnprivileged(db: Db): Promise<void> {
  const { rows } = await db.execute<{ name: string; superuser: boolean; bypassrls: boolean; owns_tables: boolean }>(sql`
    select r.rolname as name, r.rolsuper as superuser, r.rolbypassrls as bypassrls,
      exists (
        select 1 from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
          and pg_has_role(r.oid, c.relowner, 'MEMBER')
      ) as owns_tables
    from pg_roles r where r.rolname = current_user`);
  const role = rows[0];
  if (!role) throw new Error('cannot read the current database role');
  const problems = [
    role.superuser && 'is a superuser',
    role.bypassrls && 'has BYPASSRLS',
    role.owns_tables && 'owns or is a member of the owner of a table in public',
  ].filter(Boolean);
  if (problems.length > 0)
    throw new Error(
      `Database role "${role.name}" ${problems.join(' and ')}; APP_DATABASE_URL must use an unprivileged role`,
    );
}
