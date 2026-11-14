import { KDF_LIMITS } from '@agent-board/shared';
import { argon2id } from 'hash-wasm';

/** Argon2id cost: memory in KiB, passes, lanes. */
export interface KdfParams {
  m: number;
  t: number;
  p: number;
}

export const PRODUCTION_KDF: KdfParams = { m: 65_536, t: 3, p: 1 };
export const SALT_BYTES = 16;
const KEY_BYTES = 32;

export class KeyError extends Error {}

/** A wrong passphrase or recovery key; the message never says which part was wrong. */
export class WrongSecretError extends KeyError {}

/** Refuses cost parameters from a stored slot that are outside what this client will compute. */
export function assertWithinLimits(params: KdfParams): void {
  const outside = (['m', 't', 'p'] as const).some((key) => {
    const { min, max } = KDF_LIMITS[key];
    return !Number.isInteger(params[key]) || params[key] < min || params[key] > max;
  });
  if (outside) throw new KeyError('This key asks for more computing than this browser accepts, so it was not tried.');
}

/** The 32-byte wrapping key for a passphrase. The passphrase is NFKC-normalised so one passphrase types the same everywhere. */
export async function derivePassphraseKey(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<Uint8Array> {
  assertWithinLimits(params);
  return argon2id({
    password: passphrase.normalize('NFKC'),
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: KEY_BYTES,
    outputType: 'binary',
  });
}
