import {
  CryptoError,
  deriveKeys,
  encodeDataKey,
  fromBase64Url,
  generateDataKey,
  toBase64Url,
  unwrapDataKey,
  wrapDataKey,
  type KeySetup,
  type KeySlot,
  type Keys,
  type PassphraseSlot,
} from '@agent-board/shared';
import {
  assertWithinLimits,
  derivePassphraseKey,
  KeyError,
  PRODUCTION_KDF,
  SALT_BYTES,
  WrongSecretError,
  type KdfParams,
} from './kdf';
import { formatRecoveryKey, parseRecoveryKey } from './recoveryKey';

export type Secret = { kind: 'passphrase'; passphrase: string } | { kind: 'recovery'; recoveryKey: string };

const randomBytes = (length: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(length));

async function wrapWithPassphrase(passphrase: string, dataKey: Uint8Array, kdf: KdfParams): Promise<PassphraseSlot> {
  const salt = randomBytes(SALT_BYTES);
  const wrappingKey = await derivePassphraseKey(passphrase, salt, kdf);
  try {
    return {
      kind: 'passphrase',
      kdf: 'argon2id',
      ...kdf,
      salt: toBase64Url(salt),
      wrapped: await wrapDataKey(wrappingKey, dataKey),
    };
  } finally {
    wrappingKey.fill(0);
  }
}

/** Unwraps with a wrapping key; a key that does not fit is a wrong secret, whatever the reason. */
async function unwrap(wrappingKey: Uint8Array, wrapped: string): Promise<Uint8Array> {
  try {
    return await unwrapDataKey(wrappingKey, wrapped);
  } catch (error) {
    if (error instanceof CryptoError) throw new WrongSecretError('Wrong passphrase or recovery key.');
    throw error;
  }
}

async function openPassphraseSlot(slot: PassphraseSlot, passphrase: string): Promise<Uint8Array> {
  assertWithinLimits(slot);
  const salt = fromBase64Url(slot.salt);
  if (salt === null || salt.length < SALT_BYTES || salt.length > 64) throw new KeyError('This key is damaged.');
  const wrappingKey = await derivePassphraseKey(passphrase, salt, slot);
  try {
    return await unwrap(wrappingKey, slot.wrapped);
  } finally {
    wrappingKey.fill(0);
  }
}

/** The data key a secret opens. The caller owns the bytes and zeroes them when done. */
export async function openDataKey(slots: KeySlot[], secret: Secret): Promise<Uint8Array> {
  if (secret.kind === 'passphrase') {
    const slot = slots.find((candidate) => candidate.kind === 'passphrase');
    if (slot === undefined) throw new KeyError('This key has no passphrase.');
    return openPassphraseSlot(slot, secret.passphrase);
  }
  const slot = slots.find((candidate) => candidate.kind === 'recovery');
  if (slot === undefined) throw new KeyError('This key has no recovery key.');
  const recoveryKey = await parseRecoveryKey(secret.recoveryKey);
  try {
    return await unwrap(recoveryKey, slot.wrapped);
  } finally {
    recoveryKey.fill(0);
  }
}

async function deriveVerified(dataKey: Uint8Array, owner: string, keyId: string): Promise<Keys> {
  const keys = await deriveKeys(dataKey, owner);
  if (keys.keyId !== keyId) throw new KeyError('This key does not match the one the board is set up with.');
  return keys;
}

/** A new data key with a passphrase slot and a recovery slot. Nothing is stored here. */
export async function createKeySetup(options: {
  owner: string;
  passphrase: string;
  kdf?: KdfParams;
}): Promise<{ setup: KeySetup; keys: Keys; recoveryKey: string }> {
  const { owner, passphrase, kdf = PRODUCTION_KDF } = options;
  const dataKey = generateDataKey();
  const recovery = randomBytes(32);
  try {
    const keys = await deriveKeys(dataKey, owner);
    const slots: KeySlot[] = [
      await wrapWithPassphrase(passphrase, dataKey, kdf),
      { kind: 'recovery', wrapped: await wrapDataKey(recovery, dataKey) },
    ];
    return { setup: { keyId: keys.keyId, slots }, keys, recoveryKey: await formatRecoveryKey(recovery) };
  } finally {
    dataKey.fill(0);
    recovery.fill(0);
  }
}

export async function unlockKeys(options: { owner: string; stored: KeySetup; secret: Secret }): Promise<Keys> {
  const { owner, stored, secret } = options;
  const dataKey = await openDataKey(stored.slots, secret);
  try {
    return await deriveVerified(dataKey, owner, stored.keyId);
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Opens the stored key with `secret` and wraps it under a new passphrase, for a passphrase change or after unlocking with
 * the recovery key. Every other slot stays as it was. Store the returned slots with `keys.replaceSlots`.
 */
export async function replacePassphrase(options: {
  owner: string;
  stored: KeySetup;
  secret: Secret;
  newPassphrase: string;
  kdf?: KdfParams;
}): Promise<{ keys: Keys; slots: KeySlot[] }> {
  const { owner, stored, secret, newPassphrase, kdf = PRODUCTION_KDF } = options;
  const dataKey = await openDataKey(stored.slots, secret);
  try {
    const keys = await deriveVerified(dataKey, owner, stored.keyId);
    const slot = await wrapWithPassphrase(newPassphrase, dataKey, kdf);
    return { keys, slots: [slot, ...stored.slots.filter((other) => other.kind !== 'passphrase')] };
  } finally {
    dataKey.fill(0);
  }
}

export async function exportDataKey(options: { owner: string; stored: KeySetup; passphrase: string }): Promise<string> {
  const { owner, stored, passphrase } = options;
  const dataKey = await openDataKey(stored.slots, { kind: 'passphrase', passphrase });
  try {
    await deriveVerified(dataKey, owner, stored.keyId);
    return encodeDataKey(dataKey);
  } finally {
    dataKey.fill(0);
  }
}
