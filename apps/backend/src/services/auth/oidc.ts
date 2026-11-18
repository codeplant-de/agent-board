import * as client from 'openid-client';
import type { OidcConfig } from '../../config';
import { AppError } from '../errors';
import type { AuthEnv } from './env';
import { signInFailed } from './env';
import { consumeFlowOrFail, createFlow, randomId, verifierMatches } from './flows';
import { createSession } from './sessions';
import { parseUsername } from './username';

/** Discovery is cached for the life of the process; a failed sign-in drops it, so a rotated key or a moved endpoint heals on the next try. */
export class OidcClient {
  private cached: Promise<client.Configuration> | null = null;

  /** `allowInsecure` lets a test talk to an http issuer; the environment cannot set it. */
  constructor(
    private readonly oidc: OidcConfig | null,
    private readonly options: { allowInsecure?: boolean } = {},
  ) {}

  configuration(): Promise<client.Configuration> {
    if (!this.oidc) return Promise.reject(new AppError('NOT_FOUND', 'Single sign-on is not set up.'));
    this.cached ??= discover(this.oidc, this.options.allowInsecure ?? false).catch((err: unknown) => {
      this.cached = null;
      throw err;
    });
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}

async function discover(oidc: OidcConfig, allowInsecure: boolean): Promise<client.Configuration> {
  const execute = allowInsecure ? [client.allowInsecureRequests] : [];
  const found = await client.discovery(oidc.issuer, oidc.clientId, oidc.clientSecret, undefined, { execute });
  // The spec's default for a client that says nothing is client_secret_basic, which Authelia insists on.
  const methods = found.serverMetadata().token_endpoint_auth_methods_supported;
  const basic = !methods || methods.includes('client_secret_basic');
  const config = new client.Configuration(
    found.serverMetadata(),
    oidc.clientId,
    { client_secret: oidc.clientSecret },
    basic ? client.ClientSecretBasic(oidc.clientSecret) : client.ClientSecretPost(oidc.clientSecret),
  );
  execute.forEach((fn) => fn(config));
  return config;
}

const redirectUri = (env: AuthEnv): string => `${env.login.publicUrl}/login/oidc`;

function oidcOf(env: AuthEnv): OidcConfig {
  if (!env.login.oidc) throw new AppError('NOT_FOUND', 'Single sign-on is not set up.');
  return env.login.oidc;
}

export async function startOidc(env: AuthEnv, challenge: string): Promise<{ url: string }> {
  const oidc = oidcOf(env);
  try {
    const config = await env.oidc.configuration();
    const state = randomId();
    const nonce = randomId();
    const pkceVerifier = client.randomPKCECodeVerifier();
    await createFlow(env.root, { kind: 'oidc', id: state, challenge, data: { nonce, pkceVerifier } });
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(env),
      scope: oidc.scopes,
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(pkceVerifier),
      code_challenge_method: 'S256',
    });
    return { url: url.toString() };
  } catch (err) {
    throw failed(env, err, 'starting the OIDC sign-in failed');
  }
}

function failed(env: AuthEnv, err: unknown, message: string): AppError {
  if (!(err instanceof AppError)) env.oidc.invalidate();
  return signInFailed(env.log, err, message);
}

export interface OidcFinish {
  code: string;
  state: string;
  verifier: string;
  iss?: string | undefined;
}

export async function finishOidc(env: AuthEnv, input: OidcFinish): Promise<string> {
  const oidc = oidcOf(env);
  const flow = await consumeFlowOrFail(env.root, 'oidc', input.state);
  if (!verifierMatches(flow.challenge, input.verifier))
    throw new AppError('UNAUTHORIZED', 'This sign-in was started in another browser.');
  try {
    const claims = await exchangeCode(env, flow.data, input);
    const username = parseUsername(claims[oidc.usernameClaim]);
    if (!username) throw new AppError('UNAUTHORIZED', 'The identity provider sent no usable user name.');
    assertAllowedGroups(env.login.allowedGroups, claims[oidc.groupsClaim]);
    return await createSession(env, username, 'oidc');
  } catch (err) {
    throw failed(env, err, 'the OIDC sign-in failed');
  }
}

type Claims = Record<string, unknown>;

/** The ID token's claims over the userinfo endpoint's: Authelia 4.39 and newer put the username and the groups only in userinfo. */
async function exchangeCode(env: AuthEnv, data: Claims, input: OidcFinish): Promise<Claims> {
  const config = await env.oidc.configuration();
  const response = new URL(redirectUri(env));
  response.searchParams.set('code', input.code);
  response.searchParams.set('state', input.state);
  if (input.iss) response.searchParams.set('iss', input.iss);
  const tokens = await client.authorizationCodeGrant(config, response, {
    expectedState: input.state,
    expectedNonce: String(data.nonce),
    pkceCodeVerifier: String(data.pkceVerifier),
    idTokenExpected: true,
  });
  const idClaims = tokens.claims();
  if (!idClaims) throw new Error('the identity provider sent no ID token');
  const userinfo = await fetchUserinfo(env, config, tokens.access_token, idClaims.sub);
  return { ...userinfo, ...idClaims };
}

async function fetchUserinfo(
  env: AuthEnv,
  config: client.Configuration,
  accessToken: string,
  subject: string,
): Promise<Claims> {
  if (!config.serverMetadata().userinfo_endpoint) return {};
  try {
    return await client.fetchUserInfo(config, accessToken, subject);
  } catch (err) {
    env.log.warn({ err }, 'the OIDC userinfo request failed; using the ID token alone');
    return {};
  }
}

const groupsOf = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.filter((group): group is string => typeof group === 'string');
  return typeof value === 'string'
    ? value
        .split(',')
        .map((group) => group.trim())
        .filter(Boolean)
    : [];
};

function assertAllowedGroups(allowed: string[], claim: unknown): void {
  if (allowed.length === 0) return;
  if (!groupsOf(claim).some((group) => allowed.includes(group)))
    throw new AppError('FORBIDDEN', 'Your account is not allowed on this board.');
}
