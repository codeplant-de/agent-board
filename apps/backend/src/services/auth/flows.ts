import { and, eq, gt, sql, type SQL } from 'drizzle-orm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DbOrTx } from '../../db/client';
import { authFlows } from '../../db/schema';
import { AppError } from '../errors';

export type FlowKind = typeof authFlows.$inferSelect.kind;
export type FlowData = Record<string, unknown>;
export interface Flow {
  id: string;
  challenge: string | null;
  owner: string | null;
  data: FlowData;
}

const FLOW_TTL_MS = 10 * 60_000;

/** What a flow id, a challenge or a verifier looks like: it is put into URLs, so nothing else gets through. */
export const FLOW_ID = /^[A-Za-z0-9_-]{16,128}$/;
export const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export const VERIFIER = /^[A-Za-z0-9._~-]{32,128}$/;

export const randomId = (): string => randomBytes(24).toString('base64url');

/** The PKCE-style binding: the browser sends this when a redirect flow starts and the verifier it came from when it ends. */
export const challengeOf = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

export function verifierMatches(challenge: string | null, verifier: string): boolean {
  if (!challenge || !VERIFIER.test(verifier)) return false;
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(challengeOf(verifier));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function createFlow(
  db: DbOrTx,
  flow: { kind: FlowKind; id?: string; challenge?: string; owner?: string; data?: FlowData },
): Promise<string> {
  const id = flow.id ?? randomId();
  await db.insert(authFlows).values({
    id,
    kind: flow.kind,
    challenge: flow.challenge ?? null,
    owner: flow.owner ?? null,
    data: flow.data ?? {},
    expiresAt: new Date(Date.now() + FLOW_TTL_MS),
  });
  return id;
}

/** Deletes and returns a live flow in one step, so of two concurrent finishes only one gets it. */
export async function consumeFlow(
  db: DbOrTx,
  kind: FlowKind,
  id: string,
  extra: SQL = sql`true`,
): Promise<Flow | null> {
  const [row] = await db
    .delete(authFlows)
    .where(and(eq(authFlows.id, id), eq(authFlows.kind, kind), gt(authFlows.expiresAt, sql`now()`), extra))
    .returning();
  return row ? { id: row.id, challenge: row.challenge, owner: row.owner, data: row.data } : null;
}

export async function consumeFlowOrFail(db: DbOrTx, kind: FlowKind, id: string): Promise<Flow> {
  const flow = FLOW_ID.test(id) ? await consumeFlow(db, kind, id) : null;
  if (!flow) throw new AppError('UNAUTHORIZED', 'This sign-in has expired. Start again.');
  return flow;
}
