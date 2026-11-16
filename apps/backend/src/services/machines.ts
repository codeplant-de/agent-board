import { compareVersions, isSafeMachineName, MACHINE_NAME_RULE, MIN_CLIENT } from '@agent-board/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { DbOrTx } from '../db/client';
import { machines } from '../db/schema';
import { AppError } from './errors';

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** A new token for `name`, shown once; a machine that had one gets a new one and the old one stops working. */
export async function issueToken(db: DbOrTx, name: string): Promise<string> {
  if (!isSafeMachineName(name)) throw new AppError('BAD_REQUEST', `A machine name is ${MACHINE_NAME_RULE}.`);
  const token = `abm_${randomBytes(32).toString('base64url')}`;
  await db
    .insert(machines)
    .values({ name, tokenHash: hash(token) })
    .onConflictDoUpdate({
      target: [machines.owner, machines.name],
      set: {
        tokenHash: hash(token),
        revokedAt: null,
        createdAt: new Date(),
        lastSeenAt: null,
        clientVersion: null,
        clientApi: null,
        dirs: null,
        dirsIndex: null,
        dirsUpdatedAt: null,
      },
    });
  return token;
}

/**
 * The machine a bearer token belongs to and whose board it works on, or null. Runs before any owner is known, so it
 * goes through a database function that reads across owners; it also records the sighting.
 */
export async function machineForToken(db: DbOrTx, token: string): Promise<{ owner: string; name: string } | null> {
  if (!token.startsWith('abm_')) return null;
  const { rows } = await db.execute<{ owner: string; name: string }>(
    sql`select owner, name from machine_for_token(${hash(token)})`,
  );
  return rows[0] ?? null;
}

/** Whether a client at this break level can work with this server. */
export function isCompatibleClientApi(level: number): boolean {
  return level >= MIN_CLIENT;
}

/** Remembers what a machine's CLI reported; writes only when that differs from what is stored, so heartbeats do not write. */
export async function recordClient(
  db: DbOrTx,
  name: string,
  client: { version: string | null; api: number | null },
): Promise<void> {
  if (client.version === null && client.api === null) return;
  await db
    .update(machines)
    .set({ clientVersion: client.version, clientApi: client.api })
    .where(
      and(
        eq(machines.name, name),
        sql`(${machines.clientVersion} is distinct from ${client.version} or ${machines.clientApi} is distinct from ${client.api})`,
      ),
    );
}

export type ClientStatus = 'current' | 'outdated' | 'incompatible' | 'unknown';

export function clientStatus(
  machine: { clientVersion: string | null; clientApi: number | null },
  advertised: string | null,
): ClientStatus {
  const { clientVersion, clientApi } = machine;
  if (clientVersion === null && clientApi === null) return 'unknown';
  if (clientApi !== null && !isCompatibleClientApi(clientApi)) return 'incompatible';
  if (clientVersion !== null && advertised !== null && compareVersions(clientVersion, advertised) < 0)
    return 'outdated';
  return 'current';
}

export async function listMachines(db: DbOrTx, advertisedCli: string | null) {
  const rows = await db
    .select({
      name: machines.name,
      createdAt: machines.createdAt,
      lastSeenAt: machines.lastSeenAt,
      revokedAt: machines.revokedAt,
      clientVersion: machines.clientVersion,
      clientApi: machines.clientApi,
      dirs: machines.dirs,
      dirsUpdatedAt: machines.dirsUpdatedAt,
    })
    .from(machines)
    .orderBy(asc(machines.name));
  return rows.map(({ clientApi, ...machine }) => ({
    ...machine,
    clientStatus: clientStatus({ clientVersion: machine.clientVersion, clientApi }, advertisedCli),
  }));
}

export async function revokeMachine(db: DbOrTx, name: string): Promise<void> {
  await db
    .update(machines)
    .set({ revokedAt: new Date(), dirs: null, dirsIndex: null, dirsUpdatedAt: null })
    .where(eq(machines.name, name));
}

/** Stores the sealed directory list a machine sent, with the blind index of what it holds. */
export async function setMachineDirs(db: DbOrTx, name: string, list: { dirs: string; index: string }): Promise<void> {
  await db
    .update(machines)
    .set({ dirs: list.dirs, dirsIndex: list.index, dirsUpdatedAt: new Date() })
    .where(eq(machines.name, name));
}

/** The blind index of the list a machine last sent, or null when it sent none. */
export async function machineDirsIndex(db: DbOrTx, name: string): Promise<string | null> {
  const [row] = await db.select({ index: machines.dirsIndex }).from(machines).where(eq(machines.name, name));
  return row?.index ?? null;
}
