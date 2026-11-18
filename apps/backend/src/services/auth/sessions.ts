import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Db, DbOrTx } from '../../db/client';
import { appUsers, sessions } from '../../db/schema';
import { withOwner } from '../../db/scope';
import type { LoginConfig } from '../../config';
import { AppError } from '../errors';
import type { AuthLog } from './env';

export type SessionMethod = typeof sessions.$inferSelect.method;

const TOKEN_PREFIX = 'abs_';
const DAY_MS = 24 * 60 * 60_000;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const isHttps = ({ publicUrl }: Pick<LoginConfig, 'publicUrl'>): boolean => publicUrl.startsWith('https:');

/** `__Host-` makes a browser refuse the cookie from a sibling subdomain or with another path, which needs https. */
export const sessionCookieName = (login: Pick<LoginConfig, 'publicUrl'>): string =>
  isHttps(login) ? '__Host-board-session' : 'board-session';

/**
 * The browser's own limit. The server's row is the authority on when a session ends; its expiry slides with use and the
 * cookie could not follow without a header on every slide, so the cookie only has to outlast it.
 */
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/** The `Set-Cookie` value that carries `token` to the browser, or with null removes the cookie. Caddy passes only these exact shapes (apps/frontend/Caddyfile). */
export function sessionCookie(login: Pick<LoginConfig, 'publicUrl'>, token: string | null): string {
  const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token === null ? 0 : COOKIE_MAX_AGE_SECONDS}`];
  if (isHttps(login)) attributes.push('Secure');
  return `${sessionCookieName(login)}=${token ?? ''}; ${attributes.join('; ')}`;
}

/** What the session cookie of a `Cookie` header holds, if the header has one; the first, when a request carries several. */
export function cookieValue(header: string | undefined, login: Pick<LoginConfig, 'publicUrl'>): string | null {
  const name = sessionCookieName(login);
  const pair = (header ?? '').split(';').find((part) => part.trim().startsWith(`${name}=`));
  return pair === undefined ? null : pair.trim().slice(name.length + 1);
}

/** The session token a value is, or null when it is not shaped like one. */
export function tokenShaped(value: string | null): string | null {
  return value !== null && /^abs_[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

/**
 * Signs `owner` in and returns the token, to be sent as the session cookie. OIDC and SAML create the board of a new user,
 * sign into one they created or one from before sign-in, and are refused one that another method owns.
 */
export async function createSession(
  env: { root: Db; login: Pick<LoginConfig, 'sessionDays'>; log?: AuthLog },
  owner: string,
  method: SessionMethod,
): Promise<string> {
  return withOwner(env.root, owner, (tx) => insertSession(tx, env.login, owner, method, env.log));
}

/** Creates or claims the board `owner` for an OIDC or SAML sign-in. One statement decides a claim, so two methods racing for a board cannot both win. */
async function admitToBoard(tx: DbOrTx, owner: string, method: SessionMethod, log: AuthLog | undefined): Promise<void> {
  const created = await tx
    .insert(appUsers)
    .values({ username: owner, source: method })
    .onConflictDoNothing()
    .returning({ username: appUsers.username });
  if (created.length > 0) return;
  const admitted = await tx
    .update(appUsers)
    .set({ source: method })
    .where(and(eq(appUsers.username, owner), or(isNull(appUsers.source), eq(appUsers.source, method))))
    .returning({ username: appUsers.username });
  if (admitted.length > 0) return;
  const [board] = await tx.select({ source: appUsers.source }).from(appUsers).where(eq(appUsers.username, owner));
  log?.warn(
    { err: new Error(`${method} sign-in for "${owner}" refused: the board belongs to ${board?.source ?? 'nobody'}`) },
    'sign-in refused',
  );
  throw new AppError('FORBIDDEN', 'This name belongs to an account with a different sign-in method.');
}

/** For a caller already inside the owner's transaction. */
export async function insertSession(
  tx: DbOrTx,
  login: Pick<LoginConfig, 'sessionDays'>,
  owner: string,
  method: SessionMethod,
  log?: AuthLog,
): Promise<string> {
  if (method === 'passkey') await tx.insert(appUsers).values({ username: owner }).onConflictDoNothing();
  else await admitToBoard(tx, owner, method, log);
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  await tx.insert(sessions).values({
    tokenHash: hashToken(token),
    method,
    expiresAt: new Date(Date.now() + login.sessionDays * DAY_MS),
  });
  return token;
}

/**
 * The owner of a live session, or null. Runs before any owner is known, so it goes through a database function that
 * reads across owners; the same call pushes the expiry out, at most once an hour.
 */
export async function sessionOwner(
  root: Db,
  login: Pick<LoginConfig, 'sessionDays'>,
  token: string,
): Promise<string | null> {
  const { rows } = await root.execute<{ owner: string | null }>(
    sql`select session_owner(${hashToken(token)}, ${login.sessionDays * 24 * 60 * 60}) as owner`,
  );
  return rows[0]?.owner ?? null;
}

export async function deleteSession(tx: DbOrTx, tokenHash: string): Promise<void> {
  await tx.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/** Sessions and flows past their expiry; returns how many went. */
export async function purgeExpiredAuth(root: Db): Promise<number> {
  const { rows } = await root.execute<{ purged: number }>(sql`select purge_auth() as purged`);
  return rows[0]?.purged ?? 0;
}
