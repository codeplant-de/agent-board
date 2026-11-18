import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type CryptoKey } from 'jose';

const CLIENT_ID = 'board';
const CLIENT_SECRET = 'board-secret';

export interface FakeUser {
  /** Claims the ID token carries besides sub, iss, aud, nonce, iat and exp. */
  idToken?: Record<string, unknown>;
  /** What the userinfo endpoint answers besides sub. */
  userinfo?: Record<string, unknown>;
  /** Overrides the nonce the ID token carries, to play an IdP that answers for another request. */
  nonce?: string;
}

interface Grant {
  user: FakeUser;
  challenge: string;
  nonce: string;
  redirectUri: string;
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
};

/** An OpenID provider on a local port: discovery, keys, token and userinfo. The browser leg is `approve`. */
export class FakeOidcIdp {
  readonly clientId = CLIENT_ID;
  readonly clientSecret = CLIENT_SECRET;
  private readonly grants = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, FakeUser>();
  private server: Server | null = null;
  private jwk: JWK | null = null;
  private signingKey: CryptoKey | null = null;
  issuer = '';

  async start(): Promise<void> {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    this.signingKey = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, body }) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)),
        () => res.writeHead(500).end(),
      );
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no address');
    this.issuer = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** What the browser does at the authorization endpoint once the user agreed: the code and state it brings back. */
  approve(authorizationUrl: string, user: FakeUser): { code: string; state: string } {
    const params = new URL(authorizationUrl).searchParams;
    const code = randomBytes(16).toString('base64url');
    this.grants.set(code, {
      user,
      challenge: params.get('code_challenge') ?? '',
      nonce: params.get('nonce') ?? '',
      redirectUri: params.get('redirect_uri') ?? '',
    });
    return { code, state: params.get('state') ?? '' };
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const path = new URL(req.url ?? '/', this.issuer).pathname;
    if (path === '/.well-known/openid-configuration') return { status: 200, body: this.metadata() };
    if (path === '/jwks') return { status: 200, body: { keys: [this.jwk] } };
    if (path === '/token') return this.token(req);
    if (path === '/userinfo') return this.userinfo(req);
    return { status: 404, body: { error: 'not_found' } };
  }

  private metadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      userinfo_endpoint: `${this.issuer}/userinfo`,
      jwks_uri: `${this.issuer}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
    };
  }

  private async token(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    // RFC 6749 2.3.1: the id and the secret are form-encoded before they are joined.
    const [id, secret] = basic.split(':').map((part) => decodeURIComponent(part.replace(/\+/g, ' ')));
    if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return { status: 401, body: { error: 'invalid_client' } };
    const form = new URLSearchParams(await readBody(req));
    const grant = this.grants.get(form.get('code') ?? '');
    this.grants.delete(form.get('code') ?? '');
    const verifier = form.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (!grant || grant.challenge !== challenge || grant.redirectUri !== form.get('redirect_uri'))
      return { status: 400, body: { error: 'invalid_grant' } };
    const accessToken = randomBytes(16).toString('base64url');
    this.accessTokens.set(accessToken, grant.user);
    const idToken = await new SignJWT({ ...grant.user.idToken, nonce: grant.user.nonce ?? grant.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(this.issuer)
      .setAudience(CLIENT_ID)
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.signingKey!);
    return {
      status: 200,
      body: { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken },
    };
  }

  private userinfo(req: IncomingMessage): { status: number; body: unknown } {
    const user = this.accessTokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    return user
      ? { status: 200, body: { sub: 'user-1', ...user.userinfo } }
      : { status: 401, body: { error: 'invalid_token' } };
  }
}
