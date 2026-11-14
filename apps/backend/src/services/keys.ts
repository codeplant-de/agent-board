import type { KeySetup, KeySlot } from '@agent-board/shared';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { appUsers } from '../db/schema';
import { AppError } from './errors';

/** The signed-in user's key id and wrapped copies, or null before encryption is set up. Row-level security picks the user. */
export async function getKeys(db: DbOrTx): Promise<KeySetup | null> {
  const [row] = await db.select({ keyId: appUsers.keyId, slots: appUsers.keySlots }).from(appUsers);
  return row?.keyId != null && row.slots != null ? { keyId: row.keyId, slots: row.slots } : null;
}

/** Stores the first key. The conditional update is the race guard: of two concurrent setups, the second matches nothing. */
export async function setupKeys(db: DbOrTx, { keyId, slots }: KeySetup): Promise<void> {
  const updated = await db
    .update(appUsers)
    .set({ keyId, keySlots: slots })
    .where(isNull(appUsers.keyId))
    .returning({ keyId: appUsers.keyId });
  if (updated.length === 0) throw new AppError('CONFLICT', 'Encryption is already set up for this user');
}

/** Swaps the slot list of the existing key. The key id never changes, so a different one is refused. */
export async function replaceSlots(db: DbOrTx, { keyId, slots }: { keyId: string; slots: KeySlot[] }): Promise<void> {
  const updated = await db
    .update(appUsers)
    .set({ keySlots: slots })
    .where(and(eq(appUsers.keyId, keyId), isNotNull(appUsers.keySlots)))
    .returning({ keyId: appUsers.keyId });
  if (updated.length > 0) return;
  const current = await getKeys(db);
  throw new AppError(
    'CONFLICT',
    current === null ? 'Encryption is not set up yet' : 'The key id does not match this user’s key',
  );
}
