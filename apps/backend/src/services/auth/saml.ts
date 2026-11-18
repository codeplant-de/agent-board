import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { SamlConfig } from '../../config';
import { authFlows } from '../../db/schema';
import { AppError } from '../errors';
import type { AuthEnv } from './env';
import { signInFailed } from './env';
import { consumeFlow, createFlow, verifierMatches, FLOW_ID } from './flows';
import { createSession } from './sessions';
import { parseUsername } from './username';
import type { Db } from '../../db/client';

export const SAML_ACS_PATH = '/api/auth/saml/acs';

/**
 * node-saml checks `InResponseTo` against a cache of the requests it sent. Here that cache is the flow row the request
 * belongs to: found by its request id, never by the RelayState the IdP echoes, and used up once.
 */
class FlowRequestCache implements CacheProvider {
  /** The flow whose request the response answered; set when node-saml consumes the request id. */
  flowId: string | null = null;

  constructor(private readonly root: Db) {}

  async saveAsync(_key: string, value: string): Promise<CacheItem> {
    return { value, createdAt: Date.now() };
  }

  async getAsync(key: string): Promise<string | null> {
    const { rows } = await this.root.execute<{ issued_at: string }>(sql`
      select data->>'issuedAt' as issued_at from auth_flow
      where kind = 'saml' and data->>'requestId' = ${key} and data->>'consumed' is null and expires_at > now()`);
    // node-saml reads the value as the time the request was sent.
    return rows[0]?.issued_at ?? null;
  }

  async removeAsync(): Promise<string | null> {
    return null;
  }

  async consumeAsync(key: string): Promise<string | null> {
    const { rows } = await this.root.execute<{ id: string }>(sql`
      update auth_flow set data = data || '{"consumed": true}'::jsonb
      where kind = 'saml' and data->>'requestId' = ${key} and data->>'consumed' is null and expires_at > now()
      returning id`);
    this.flowId = rows[0]?.id ?? null;
    return this.flowId ? key : null;
  }
}

function samlOf(env: AuthEnv): SamlConfig {
  if (!env.login.saml) throw new AppError('NOT_FOUND', 'SAML sign-on is not set up.');
  return env.login.saml;
}

function samlClient(env: AuthEnv, cacheProvider: CacheProvider, requestId?: string): SAML {
  const saml = samlOf(env);
  return new SAML({
    entryPoint: saml.entryPoint,
    issuer: saml.issuer,
    audience: saml.issuer,
    callbackUrl: `${env.login.publicUrl}${SAML_ACS_PATH}`,
    idpCert: saml.idpCert,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    // Only a response to a request this board sent: no IdP-initiated sign-in.
    validateInResponseTo: ValidateInResponseTo.always,
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 60_000,
    cacheProvider,
    ...(requestId ? { generateUniqueId: () => requestId } : {}),
  });
}

export async function startSaml(env: AuthEnv, challenge: string): Promise<{ url: string }> {
  try {
    // An XML ID must not start with a digit.
    const requestId = `_${randomBytes(20).toString('hex')}`;
    const flowId = await createFlow(env.root, {
      kind: 'saml',
      challenge,
      data: { requestId, issuedAt: new Date().toISOString() },
    });
    const url = await samlClient(env, new FlowRequestCache(env.root), requestId).getAuthorizeUrlAsync(flowId, {});
    return { url };
  } catch (err) {
    throw signInFailed(env.log, err, 'starting the SAML sign-in failed');
  }
}

function usernameOf(saml: SamlConfig, profile: Profile): string | null {
  const value = saml.usernameAttribute ? profile[saml.usernameAttribute] : profile.nameID;
  return parseUsername(Array.isArray(value) ? value[0] : value);
}

/** Why the ACS sent the browser back without a sign-in; the sign-in page has a sentence for each, so the set is fixed. */
export type SamlErrorCode = 'failed' | 'no_user';

/**
 * Checks the IdP's response and parks the user name on the flow it answers; `finishSaml` hands it to the browser that
 * started the flow. Returns the flow id, or why the response was refused: the ACS is a navigation, so it cannot show an error itself.
 */
export async function acceptSamlResponse(
  env: AuthEnv,
  samlResponse: unknown,
): Promise<{ flow: string } | { error: SamlErrorCode }> {
  if (typeof samlResponse !== 'string' || samlResponse.length === 0) return { error: 'failed' };
  const cache = new FlowRequestCache(env.root);
  try {
    const { profile } = await samlClient(env, cache).validatePostResponseAsync({ SAMLResponse: samlResponse });
    const username = profile ? usernameOf(samlOf(env), profile) : null;
    if (!username || !cache.flowId || !FLOW_ID.test(cache.flowId)) return { error: 'no_user' };
    await env.root.execute(sql`
      update auth_flow set data = data || jsonb_build_object('username', ${username}::text) where id = ${cache.flowId}`);
    return { flow: cache.flowId };
  } catch (err) {
    env.log.warn({ err }, 'the SAML response was refused');
    return { error: 'failed' };
  }
}

export async function finishSaml(env: AuthEnv, input: { flow: string; verifier: string }): Promise<string> {
  samlOf(env);
  const flow = FLOW_ID.test(input.flow)
    ? await consumeFlow(env.root, 'saml', input.flow, sql`${authFlows.data}->>'username' is not null`)
    : null;
  if (!flow) throw new AppError('UNAUTHORIZED', 'This sign-in has expired. Start again.');
  const username = parseUsername(flow.data.username);
  if (!username || !verifierMatches(flow.challenge, input.verifier))
    throw new AppError('UNAUTHORIZED', 'This sign-in was started in another browser.');
  return createSession(env, username, 'saml');
}
