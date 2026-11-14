import { isSafeMachineName } from '@agent-board/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { DbOrTx } from '../db/client';
import { machines } from '../db/schema';
import { AppError } from './errors';

const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** A new token for `name`, shown once; a machine that had one gets a new one and the old one stops working. */
export async function issueToken(db: DbOrTx, name: string): Promise<string> {
  if (!isSafeMachineName(name))
    throw new AppError('BAD_REQUEST', "A machine name has letters, digits, '.', '-' and '_' only.");
  const token = `abm_${randomBytes(32).toString('base64url')}`;
  await db
    .insert(machines)
    .values({ name, tokenHash: hash(token) })
    .onConflictDoUpdate({
      target: [machines.owner, machines.name],
      set: { tokenHash: hash(token), revokedAt: null, createdAt: new Date(), lastSeenAt: null },
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

export async function listMachines(db: DbOrTx) {
  return db
    .select({
      name: machines.name,
      createdAt: machines.createdAt,
      lastSeenAt: machines.lastSeenAt,
      revokedAt: machines.revokedAt,
    })
    .from(machines)
    .orderBy(asc(machines.name));
}

export async function revokeMachine(db: DbOrTx, name: string): Promise<void> {
  await db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.name, name));
}
