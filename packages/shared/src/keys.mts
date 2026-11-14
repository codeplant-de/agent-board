// How a user's data key is stored on the server: one wrapped copy per way of unlocking it. The server keeps the slots
// and cannot open them; the browser opens one with a passphrase or a recovery key.
import { ContractError } from './contract.mts';
import { isWrappedKey } from './crypto.mts';
import { isRecord } from './guards.mts';

// Bounds on what a stored slot may ask a client to compute. The intended parameters are m = 65536 (64 MiB), t = 3, p = 1;
// the maxima leave room to raise them later but stop a hostile value from making a browser allocate gigabytes.
export const KDF_LIMITS = {
  m: { min: 8192, max: 262_144 },
  t: { min: 1, max: 10 },
  p: { min: 1, max: 4 },
} as const;
export const MAX_KEY_SLOTS = 4;

export interface PassphraseSlot {
  kind: 'passphrase';
  kdf: 'argon2id';
  // Memory in KiB, passes and lanes.
  m: number;
  t: number;
  p: number;
  // base64url, 16 to 64 bytes.
  salt: string;
  wrapped: string;
}

export interface RecoverySlot {
  kind: 'recovery';
  wrapped: string;
}

export type KeySlot = PassphraseSlot | RecoverySlot;

export interface KeySetup {
  keyId: string;
  slots: KeySlot[];
}

// 16 bytes are 22 base64url characters, 64 bytes are 86.
const SALT = /^[A-Za-z0-9_-]{22,86}$/;
const KEY_ID = /^[0-9a-f]{16}$/;

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: string[], what: string): void {
  const extra = Object.keys(obj).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new ContractError(`${what} has an unknown key "${extra}"`);
}

function bounded(obj: Record<string, unknown>, key: 'm' | 't' | 'p', what: string): number {
  const value = obj[key];
  const { min, max } = KDF_LIMITS[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new ContractError(`${what}.${key} must be a whole number from ${min} to ${max}`);
  return value;
}

function wrapped(obj: Record<string, unknown>, what: string): string {
  const value = obj['wrapped'];
  if (typeof value !== 'string' || !isWrappedKey(value))
    throw new ContractError(`${what}.wrapped is not a wrapped key`);
  return value;
}

function parseSlot(value: unknown, what: string): KeySlot {
  if (!isRecord(value)) throw new ContractError(`${what} must be a JSON object`);
  if (value['kind'] === 'recovery') {
    rejectUnknownKeys(value, ['kind', 'wrapped'], what);
    return { kind: 'recovery', wrapped: wrapped(value, what) };
  }
  if (value['kind'] !== 'passphrase') throw new ContractError(`${what}.kind must be "passphrase" or "recovery"`);
  rejectUnknownKeys(value, ['kind', 'kdf', 'm', 't', 'p', 'salt', 'wrapped'], what);
  if (value['kdf'] !== 'argon2id') throw new ContractError(`${what}.kdf must be "argon2id"`);
  const salt = value['salt'];
  if (typeof salt !== 'string' || !SALT.test(salt))
    throw new ContractError(`${what}.salt must be 16 to 64 bytes as base64url`);
  return {
    kind: 'passphrase',
    kdf: 'argon2id',
    m: bounded(value, 'm', what),
    t: bounded(value, 't', what),
    p: bounded(value, 'p', what),
    salt,
    wrapped: wrapped(value, what),
  };
}

export function isKeyId(value: unknown): value is string {
  return typeof value === 'string' && KEY_ID.test(value);
}

export function parseKeyId(value: unknown): string {
  if (!isKeyId(value)) throw new ContractError('keyId must be 16 lower-case hex characters');
  return value;
}

// One to four slots, at most one per kind, and a passphrase slot among them.
export function parseKeySlots(value: unknown): KeySlot[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_KEY_SLOTS)
    throw new ContractError(`slots must be a list of 1 to ${MAX_KEY_SLOTS} slots`);
  const slots = value.map((slot, i) => parseSlot(slot, `slots[${i}]`));
  const kinds = slots.map((slot) => slot.kind);
  if (new Set(kinds).size !== kinds.length) throw new ContractError('slots may hold at most one slot of each kind');
  if (!kinds.includes('passphrase')) throw new ContractError('slots need a passphrase slot');
  return slots;
}

export function parseKeySetup(value: unknown): KeySetup {
  if (!isRecord(value)) throw new ContractError('key setup must be a JSON object');
  rejectUnknownKeys(value, ['keyId', 'slots'], 'key setup');
  return { keyId: parseKeyId(value['keyId']), slots: parseKeySlots(value['slots']) };
}
