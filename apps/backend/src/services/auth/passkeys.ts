import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { COSEALG } from '@simplewebauthn/server/helpers';
import { asc, eq, sql } from 'drizzle-orm';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { LoginConfig } from '../../config';
import type { DbOrTx } from '../../db/client';
import { appUsers, authFlows, passkeys } from '../../db/schema';
import { withOwner } from '../../db/scope';
import { AppError } from '../errors';
import type { AuthEnv } from './env';
import { signInFailed } from './env';
import { consumeFlow, consumeFlowOrFail, createFlow, FLOW_ID } from './flows';
import { insertSession, createSession } from './sessions';
import { parseSignupUsername } from './username';
import {
  asAuthenticationJson,
  asRegistrationJson,
  type AuthenticationInput,
  type RegistrationInput,
} from './webauthnSchemas';

const RP_NAME = 'Agent board';
/** The algorithms the board offers and accepts; named, so the library does not probe the runtime for post-quantum ones. */
const SUPPORTED_ALGORITHMS = [COSEALG.EdDSA, COSEALG.ES256, COSEALG.RS256];
export const MAX_PASSKEY_NAME_LENGTH = 60;
const DEFAULT_NAME = 'Passkey';

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');
const fromB64 = (value: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(value, 'base64url'));

/** The WebAuthn user handle: stable per user and not the name itself. */
const userHandle = (owner: string): Uint8Array<ArrayBuffer> => new Uint8Array(sha256(`agent-board-user:${owner}`));

function requirePasskeys(login: LoginConfig): void {
  if (!login.passkeys) throw new AppError('NOT_FOUND', 'Passkeys are switched off on this board.');
}

/** A device label: plain text, one line, at most 60 characters. */
export function parsePasskeyName(raw: string | undefined, fallback?: string): string {
  // eslint-disable-next-line no-control-regex
  const name = (raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  if (name.length > MAX_PASSKEY_NAME_LENGTH)
    throw new AppError('BAD_REQUEST', `A passkey name is at most ${MAX_PASSKEY_NAME_LENGTH} characters.`);
  if (name) return name;
  if (fallback) return fallback;
  throw new AppError('BAD_REQUEST', 'Give the passkey a name.');
}

function challengeOf(data: Record<string, unknown>): string {
  if (typeof data.challenge !== 'string') throw new AppError('UNAUTHORIZED', 'This sign-in has expired. Start again.');
  return data.challenge;
}

type StoredPasskey = typeof passkeys.$inferSelect;

async function registrationOptions(
  login: LoginConfig,
  userName: string,
  owner: string,
  existing: Pick<StoredPasskey, 'credentialId' | 'transports'>[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: login.rpId,
    userName,
    userID: userHandle(owner),
    attestationType: 'none',
    excludeCredentials: existing.map(({ credentialId, transports }) => ({ id: credentialId, transports })),
    supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
}

async function verifiedRegistration(login: LoginConfig, response: RegistrationInput, challenge: string) {
  const result = await verifyRegistrationResponse({
    response: asRegistrationJson(response),
    expectedChallenge: challenge,
    expectedOrigin: login.publicUrl,
    expectedRPID: login.rpId,
    requireUserVerification: true,
    supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
  });
  if (!result.verified) throw new AppError('UNAUTHORIZED', 'The passkey could not be verified.');
  return result.registrationInfo.credential;
}

function passkeyRow(
  credential: Awaited<ReturnType<typeof verifiedRegistration>>,
  response: RegistrationInput,
  name: string,
) {
  return {
    credentialId: credential.id,
    publicKey: b64(credential.publicKey),
    counter: credential.counter,
    transports: response.response.transports ?? credential.transports ?? [],
    name,
  };
}

// --- Sign in with a passkey ---

export async function loginOptions(
  env: AuthEnv,
): Promise<{ flow: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  requirePasskeys(env.login);
  const options = await generateAuthenticationOptions({ rpID: env.login.rpId, userVerification: 'required' });
  const flow = await createFlow(env.root, { kind: 'passkey-login', data: { challenge: options.challenge } });
  return { flow, options };
}

type StoredCredential = {
  owner: string;
  public_key: string;
  counter: string | number;
  transports: string[];
};

export async function loginWithPasskey(
  env: AuthEnv,
  input: { flow: string; response: AuthenticationInput },
): Promise<string> {
  requirePasskeys(env.login);
  const flow = await consumeFlowOrFail(env.root, 'passkey-login', input.flow);
  try {
    const { rows } = await env.root.execute<StoredCredential>(
      sql`select * from passkey_by_credential(${input.response.id})`,
    );
    const stored = rows[0];
    if (!stored) throw new AppError('UNAUTHORIZED', 'This passkey is not known to the board.');
    const verified = await verifyAuthenticationResponse({
      response: asAuthenticationJson(input.response),
      expectedChallenge: challengeOf(flow.data),
      expectedOrigin: env.login.publicUrl,
      expectedRPID: env.login.rpId,
      requireUserVerification: true,
      credential: {
        id: input.response.id,
        publicKey: fromB64(stored.public_key),
        counter: Number(stored.counter),
        transports: stored.transports,
      },
    });
    if (!verified.verified) throw new AppError('UNAUTHORIZED', 'The passkey could not be verified.');
    const { rows: used } = await env.root.execute<{ ok: boolean }>(
      sql`select passkey_used(${input.response.id}, ${verified.authenticationInfo.newCounter}) as ok`,
    );
    if (!used[0]?.ok) throw new AppError('UNAUTHORIZED', 'The passkey was used before: it may have been cloned.');
    return await createSession(env, stored.owner, 'passkey');
  } catch (err) {
    throw signInFailed(env.log, err, 'the passkey sign-in failed');
  }
}

// --- Sign up with a passkey ---

function assertSignupToken(login: LoginConfig, presented: string): void {
  if (!login.signupToken) throw new AppError('FORBIDDEN', 'Sign-up is closed on this board.');
  const expected = sha256(login.signupToken);
  if (!timingSafeEqual(expected, sha256(presented))) throw new AppError('FORBIDDEN', 'The sign-up token is not right.');
}

async function isUsernameTaken(env: Pick<AuthEnv, 'root'>, username: string): Promise<boolean> {
  const { rows } = await env.root.execute<{ taken: boolean }>(sql`select username_taken(${username}) as taken`);
  return rows[0]?.taken ?? true;
}

const TAKEN = new AppError('CONFLICT', 'That name is taken. Pick another.');

/** The token is checked first, so a caller without it learns nothing about which names exist. */
export async function signupOptions(
  env: AuthEnv,
  input: { username: string; signupToken: string },
): Promise<{ flow: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  requirePasskeys(env.login);
  assertSignupToken(env.login, input.signupToken);
  const username = parseSignupUsername(input.username);
  if (!username)
    throw new AppError(
      'BAD_REQUEST',
      'A name is lower case letters, digits, dots, dashes, underscores and @, up to 64.',
    );
  if (await isUsernameTaken(env, username)) throw TAKEN;
  const options = await registrationOptions(env.login, username, username, []);
  const flow = await createFlow(env.root, { kind: 'passkey-signup', data: { challenge: options.challenge, username } });
  return { flow, options };
}

export async function signupWithPasskey(
  env: AuthEnv,
  input: { flow: string; response: RegistrationInput; name?: string | undefined },
): Promise<string> {
  requirePasskeys(env.login);
  const flow = await consumeFlowOrFail(env.root, 'passkey-signup', input.flow);
  try {
    const username = parseSignupUsername(String(flow.data.username));
    if (!username) throw new AppError('UNAUTHORIZED', 'This sign-in has expired. Start again.');
    const credential = await verifiedRegistration(env.login, input.response, challengeOf(flow.data));
    const row = passkeyRow(credential, input.response, parsePasskeyName(input.name, DEFAULT_NAME));
    return await withOwner(env.root, username, async (tx) => {
      const created = await tx
        .insert(appUsers)
        .values({ username, source: 'passkey' })
        .onConflictDoNothing()
        .returning();
      if (created.length === 0) throw TAKEN;
      const stored = await tx.insert(passkeys).values(row).onConflictDoNothing().returning();
      if (stored.length === 0) throw new AppError('CONFLICT', 'That passkey is already registered.');
      return insertSession(tx, env.login, username, 'passkey');
    });
  } catch (err) {
    throw signInFailed(env.log, err, 'the passkey sign-up failed');
  }
}

// --- A signed-in user's passkeys ---

export async function listPasskeys(tx: DbOrTx) {
  const rows = await tx.select().from(passkeys).orderBy(asc(passkeys.createdAt));
  return rows.map(({ credentialId, name, createdAt, lastUsedAt }) => ({
    id: credentialId,
    name,
    createdAt,
    lastUsedAt,
  }));
}

export async function registerOptions(
  tx: DbOrTx,
  login: LoginConfig,
  owner: string,
): Promise<{ flow: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  requirePasskeys(login);
  const existing = await tx.select().from(passkeys);
  const options = await registrationOptions(login, owner, owner, existing);
  const flow = await createFlow(tx, { kind: 'passkey-register', owner, data: { challenge: options.challenge } });
  return { flow, options };
}

export async function registerPasskey(
  tx: DbOrTx,
  login: LoginConfig,
  owner: string,
  input: { flow: string; response: RegistrationInput; name: string },
): Promise<void> {
  requirePasskeys(login);
  const name = parsePasskeyName(input.name);
  const flow = FLOW_ID.test(input.flow)
    ? await consumeFlow(tx, 'passkey-register', input.flow, sql`${authFlows.owner} = ${owner}`)
    : null;
  if (!flow) throw new AppError('UNAUTHORIZED', 'This registration has expired. Start again.');
  const credential = await verifiedRegistration(login, input.response, challengeOf(flow.data)).catch((err: unknown) => {
    // The library throws plain errors for a response that does not check out.
    throw err instanceof AppError ? err : new AppError('BAD_REQUEST', 'The passkey could not be verified.');
  });
  const stored = await tx
    .insert(passkeys)
    .values(passkeyRow(credential, input.response, name))
    .onConflictDoNothing()
    .returning();
  if (stored.length === 0) throw new AppError('CONFLICT', 'That passkey is already registered.');
}

export async function renamePasskey(tx: DbOrTx, id: string, name: string): Promise<void> {
  const renamed = await tx
    .update(passkeys)
    .set({ name: parsePasskeyName(name) })
    .where(eq(passkeys.credentialId, id))
    .returning();
  if (renamed.length === 0) throw new AppError('NOT_FOUND', 'No such passkey.');
}

/** A user whose board a passkey created has no other way in, so their last one stays. */
export async function removePasskey(tx: DbOrTx, id: string): Promise<void> {
  // The lock serialises two removals, which would each see the other's passkey and leave none.
  const [board] = await tx.select({ source: appUsers.source }).from(appUsers).for('update');
  if (board?.source === 'passkey') {
    const owned = await tx.select({ id: passkeys.credentialId }).from(passkeys);
    if (owned.length <= 1)
      throw new AppError('CONFLICT', 'This is your only way to sign in: add another passkey before removing it.');
  }
  const removed = await tx.delete(passkeys).where(eq(passkeys.credentialId, id)).returning();
  if (removed.length === 0) throw new AppError('NOT_FOUND', 'No such passkey.');
}
