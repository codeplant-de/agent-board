import { sql } from 'drizzle-orm';
import type { Db, Tx } from './client';

/** Runs `fn` in a transaction in which `app.owner` is `owner`; the setting is gone when the transaction ends. */
export function withOwner<T>(db: Db, owner: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.owner', ${owner}, true)`);
    return fn(tx);
  });
}
