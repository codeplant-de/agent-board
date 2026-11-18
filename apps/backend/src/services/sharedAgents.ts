/**
 * The agent definitions a user pushed for all their machines: one sealed document per user, which the server cannot read.
 * A push is compare-and-set on the clear version, so two CLIs pushing at once cannot overwrite each other unseen.
 */
import type { WireSetAgents, WireSharedAgents } from '@agent-board/shared';
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { sharedAgents } from '../db/schema';
import { AppError } from './errors';

/** The version of the user's document, or null when they pushed none; what the `version` answer carries on every tick. */
export async function sharedAgentsVersion(db: DbOrTx): Promise<number | null> {
  const [row] = await db.select({ version: sharedAgents.version }).from(sharedAgents);
  return row?.version ?? null;
}

/** The sealed document and its version, or null. */
export async function getSharedAgents(db: DbOrTx): Promise<WireSharedAgents | null> {
  const [row] = await db.select({ version: sharedAgents.version, document: sharedAgents.document }).from(sharedAgents);
  return row ?? null;
}

/** The sealed document with its version and when it was pushed, or null: what the browser's Agents page opens and shows. */
export async function sharedAgentsForBrowser(
  db: DbOrTx,
): Promise<{ version: number; document: string; pushedAt: Date } | null> {
  const [row] = await db
    .select({ version: sharedAgents.version, document: sharedAgents.document, pushedAt: sharedAgents.pushedAt })
    .from(sharedAgents);
  return row ?? null;
}

/**
 * Stores the next version of the document while the stored one is still `expectedVersion` (0: none is stored); a conflict
 * when another push came first. The parser has checked that `version` is `expectedVersion + 1`.
 */
export async function setSharedAgents(
  db: DbOrTx,
  { document, version, expectedVersion }: WireSetAgents,
): Promise<void> {
  const written =
    expectedVersion === 0
      ? await db
          .insert(sharedAgents)
          .values({ version, document })
          .onConflictDoNothing()
          .returning({ version: sharedAgents.version })
      : await db
          .update(sharedAgents)
          .set({ version, document, pushedAt: sql`now()` })
          .where(eq(sharedAgents.version, expectedVersion))
          .returning({ version: sharedAgents.version });
  if (written.length === 0) {
    const current = await sharedAgentsVersion(db);
    throw new AppError(
      'CONFLICT',
      `the board holds version ${current ?? 'none'} of the shared agents, not ${expectedVersion === 0 ? 'none' : expectedVersion}; fetch them again`,
    );
  }
}
