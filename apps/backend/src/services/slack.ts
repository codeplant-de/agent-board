import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Db, DbOrTx } from '../db/client';
import { withOwner } from '../db/scope';
import { slackInbox, slackLinks } from '../db/schema';
import { AppError } from './errors';
import { daysBefore, INBOX_RETENTION_DAYS } from './retention';
import { newId } from './taskRows';

export const LINK_CODE_MINUTES = 15;

export interface SlackIdentity {
  teamId: string;
  slackUserId: string;
}

const hashCode = (code: string): string => createHash('sha256').update(code).digest('hex');

/** A one-time code for `identity`; it replaces the code that user asked for before. Only its hash is stored. */
export async function createLinkCode(
  db: DbOrTx,
  identity: SlackIdentity,
  displayName: string | null,
  now: Date = new Date(),
): Promise<string> {
  const code = randomBytes(24).toString('base64url');
  const expires = new Date(now.getTime() + LINK_CODE_MINUTES * 60_000);
  await db.execute(
    sql`select slack_link_code_create(${hashCode(code)}, ${identity.teamId}, ${identity.slackUserId}, ${displayName}, ${expires})`,
  );
  return code;
}

interface CodeRow extends Record<string, unknown> {
  team_id: string;
  slack_user_id: string;
  display_name: string | null;
}

/** Who a code is for, without using it up; null when it is unknown, expired or used. */
export async function peekLinkCode(
  db: DbOrTx,
  code: string,
): Promise<{ slackUserId: string; displayName: string | null } | null> {
  const { rows } = await db.execute<CodeRow>(sql`select * from slack_link_code_peek(${hashCode(code)})`);
  return rows[0] ? { slackUserId: rows[0].slack_user_id, displayName: rows[0].display_name } : null;
}

/**
 * Binds the Slack user a code was issued to to the current owner, replacing the owner's earlier link. Run it in the
 * request's transaction: when it throws, the code is not used up.
 */
export async function redeemLinkCode(tx: DbOrTx, code: string): Promise<{ slackUserId: string }> {
  const { rows } = await tx.execute<CodeRow>(sql`select * from slack_link_code_redeem(${hashCode(code)})`);
  const redeemed = rows[0];
  if (!redeemed) throw new AppError('NOT_FOUND', 'This link has expired or was already used. Send /board link again.');
  await tx.delete(slackLinks);
  const inserted = await tx
    .insert(slackLinks)
    .values({ teamId: redeemed.team_id, slackUserId: redeemed.slack_user_id, displayName: redeemed.display_name })
    .onConflictDoNothing()
    .returning({ owner: slackLinks.owner });
  if (inserted.length === 0) throw new AppError('CONFLICT', 'That Slack user is linked to another board account.');
  return { slackUserId: redeemed.slack_user_id };
}

export async function getLink(db: DbOrTx) {
  const [row] = await db.select().from(slackLinks);
  return row ?? null;
}

/** True when there was a link to remove. With `who`, only the link to that Slack user goes: a newer link to another one stays. */
export async function removeLink(db: DbOrTx, who?: SlackIdentity): Promise<boolean> {
  const removed = await db
    .delete(slackLinks)
    .where(who && and(eq(slackLinks.teamId, who.teamId), eq(slackLinks.slackUserId, who.slackUserId)))
    .returning({ owner: slackLinks.owner });
  return removed.length > 0;
}

/** The board user a Slack user is linked to, if any. An intake call carries no board session, so this is the one lookup across owners. */
export async function ownerOf(db: Db, identity: SlackIdentity): Promise<string | null> {
  const { rows } = await db.execute<{ owner: string | null }>(
    sql`select slack_owner_for(${identity.teamId}, ${identity.slackUserId}) as owner`,
  );
  return rows[0]?.owner ?? null;
}

export async function addInboxItem(db: Db, owner: string, item: { text: string; slackUserId: string }): Promise<void> {
  await withOwner(db, owner, (tx) => tx.insert(slackInbox).values({ id: newId(12), ...item }));
}

export async function listInbox(db: DbOrTx) {
  return db.select().from(slackInbox).orderBy(desc(slackInbox.createdAt), desc(slackInbox.id));
}

export async function removeInboxItem(db: DbOrTx, id: string): Promise<void> {
  await db.delete(slackInbox).where(eq(slackInbox.id, id));
}

/** Items nobody turned into a task or dismissed are plain text; they do not stay. Returns how many it deleted. */
export async function deleteOldInbox(db: DbOrTx, now: Date = new Date()): Promise<number> {
  const gone = await db
    .delete(slackInbox)
    .where(lt(slackInbox.createdAt, daysBefore(now, INBOX_RETENTION_DAYS)))
    .returning({ id: slackInbox.id });
  return gone.length;
}
