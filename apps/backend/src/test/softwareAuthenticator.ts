import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { AuthenticationInput, RegistrationInput } from '../services/auth/webauthnSchemas';

const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest();

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

// Just enough CBOR for an attestation object and a COSE key.
const cborHead = (major: number, length: number): Buffer => {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
};
const cborBytes = (bytes: Uint8Array): Buffer => Buffer.concat([cborHead(2, bytes.length), bytes]);
const cborText = (text: string): Buffer => Buffer.concat([cborHead(3, text.length), Buffer.from(text)]);
const cborInt = (value: number): Buffer => (value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value));
const cborMap = (entries: [Buffer, Buffer][]): Buffer =>
  Buffer.concat([cborHead(5, entries.length), ...entries.flat()]);

const counterBytes = (counter: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(counter);
  return bytes;
};

export interface AssertOptions {
  /** Signs this challenge instead of the one the board sent. */
  challenge?: string;
  origin?: string;
  /** Reports this counter instead of the next one. */
  counter?: number;
}

/** A passkey in software: an ES256 key and the bytes a browser would send for it, built by hand. */
export class SoftwareAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  private counter = 0;

  constructor(
    private readonly rpId = 'localhost',
    private readonly defaultOrigin = 'http://localhost:5173',
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.publicJwk = { x: jwk.x ?? '', y: jwk.y ?? '' };
  }

  get id(): string {
    return this.credentialId.toString('base64url');
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  private authenticatorData(flags: number, counter: number, attested: Buffer = Buffer.alloc(0)): Buffer {
    return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), counterBytes(counter), attested]);
  }

  register(
    options: { challenge: string },
    overrides: Pick<AssertOptions, 'challenge' | 'origin'> = {},
  ): RegistrationInput {
    const coseKey = cborMap([
      [cborInt(1), cborInt(2)],
      [cborInt(3), cborInt(-7)],
      [cborInt(-1), cborInt(1)],
      [cborInt(-2), cborBytes(Buffer.from(this.publicJwk.x, 'base64url'))],
      [cborInt(-3), cborBytes(Buffer.from(this.publicJwk.y, 'base64url'))],
    ]);
    const attested = Buffer.concat([
      Buffer.alloc(16),
      Buffer.from([0, this.credentialId.length]),
      this.credentialId,
      coseKey,
    ]);
    const authData = this.authenticatorData(FLAG_UP | FLAG_UV | FLAG_AT, this.counter, attested);
    const attestationObject = cborMap([
      [cborText('fmt'), cborText('none')],
      [cborText('attStmt'), cborMap([])],
      [cborText('authData'), cborBytes(authData)],
    ]);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: this.clientData(
          'webauthn.create',
          overrides.challenge ?? options.challenge,
          overrides.origin ?? this.defaultOrigin,
        ).toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
    };
  }

  assert(options: { challenge: string }, overrides: AssertOptions = {}): AuthenticationInput {
    this.counter = overrides.counter ?? this.counter + 1;
    const clientDataJSON = this.clientData(
      'webauthn.get',
      overrides.challenge ?? options.challenge,
      overrides.origin ?? this.defaultOrigin,
    );
    const authData = this.authenticatorData(FLAG_UP | FLAG_UV, this.counter);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
    };
  }
}
