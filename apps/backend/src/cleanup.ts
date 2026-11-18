import { sql } from 'drizzle-orm';
import type { Db } from './db/client';
import { withOwner } from './db/scope';
import { purgeExpiredAuth } from './services/auth/sessions';
import { archiveStaleDone } from './services/tasks';
import { deleteOldTranscripts } from './services/transcripts';

/**
 * Expired sessions and sign-in flows go. Tasks untouched in Done for 7 days are closed, the transcripts of tasks closed 14 days ago go, for every user's board in turn. A failing board is reported and does not stop the others.
 */
export async function cleanupAllBoards(
  db: Db,
  log: { info(message: string): void; error(context: { err: unknown }, message: string): void },
  now: Date = new Date(),
): Promise<void> {
  const purged = await purgeExpiredAuth(db).catch((err: unknown) => {
    log.error({ err }, 'purging expired sessions failed');
    return 0;
  });
  if (purged > 0) log.info(`purged ${purged} expired sessions and sign-in flows`);
  const { rows } = await db.execute<{ username: string }>(sql`select username from board_owners()`);
  for (const { username } of rows) {
    try {
      const closed = await withOwner(db, username, (tx) => archiveStaleDone(tx, now));
      if (closed > 0) log.info(`closed ${closed} old done tasks of ${username}`);
      const deleted = await withOwner(db, username, (tx) => deleteOldTranscripts(tx, now));
      if (deleted > 0) log.info(`deleted ${deleted} old transcript runs of ${username}`);
    } catch (err) {
      log.error({ err }, `cleanup of ${username} failed`);
    }
  }
}
