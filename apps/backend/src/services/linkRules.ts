/**
 * The link rules a user set in the browser: one sealed document per user, which the server cannot read. A save is
 * compare-and-set on the clear version, so two tabs saving at once cannot overwrite each other unseen.
 */
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { linkRules } from '../db/schema';
import { AppError } from './errors';

export interface StoredLinkRules {
  version: number;
  document: string;
  updatedAt: Date;
}

/** The sealed document with its version and when it was saved, or null when the user saved none. */
export async function getLinkRules(db: DbOrTx): Promise<StoredLinkRules | null> {
  const [row] = await db
    .select({ version: linkRules.version, document: linkRules.document, updatedAt: linkRules.updatedAt })
    .from(linkRules);
  return row ?? null;
}

/**
 * Stores the next version of the document while the stored one is still `expectedVersion` (0: none is stored); a conflict
 * when another save came first. The input check has seen that `version` is `expectedVersion + 1`.
 */
export async function setLinkRules(
  db: DbOrTx,
  { document, version, expectedVersion }: { document: string; version: number; expectedVersion: number },
): Promise<void> {
  const written =
    expectedVersion === 0
      ? await db
          .insert(linkRules)
          .values({ version, document })
          .onConflictDoNothing()
          .returning({ version: linkRules.version })
      : await db
          .update(linkRules)
          .set({ version, document, updatedAt: sql`now()` })
          .where(eq(linkRules.version, expectedVersion))
          .returning({ version: linkRules.version });
  if (written.length === 0) {
    const current = await getLinkRules(db);
    throw new AppError(
      'CONFLICT',
      `the board holds version ${current?.version ?? 'none'} of the link rules, not ${expectedVersion === 0 ? 'none' : expectedVersion}; reload them`,
    );
  }
}
