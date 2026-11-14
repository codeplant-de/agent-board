import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ContractError } from '../src/contract.mts';
import { generateDataKey, isWrappedKey, wrapDataKey } from '../src/crypto.mts';
import { isKeyId, parseKeySetup, parseKeySlots } from '../src/keys.mts';

const wrapped = await wrapDataKey(generateDataKey(), generateDataKey());
const passphrase = { kind: 'passphrase', kdf: 'argon2id', m: 65536, t: 3, p: 1, salt: 'A'.repeat(22), wrapped };
const recovery = { kind: 'recovery', wrapped };
const rejects = (value: unknown, pattern: RegExp) =>
  assert.throws(
    () => parseKeySlots(value),
    (error) => error instanceof ContractError && pattern.test(error.message),
  );

test('isWrappedKey is structural', () => {
  assert.ok(isWrappedKey(wrapped));
  assert.ok(!isWrappedKey('abw1.AAAA'));
  assert.ok(!isWrappedKey(wrapped.replace('abw1.', 'abe1.')));
  assert.ok(!isWrappedKey(`${wrapped}A`));
  assert.ok(!isWrappedKey(`${wrapped.slice(0, -1)}!`));
});

test('parseKeySlots accepts a passphrase slot, alone or with a recovery slot', () => {
  assert.deepEqual(parseKeySlots([passphrase]), [passphrase]);
  assert.deepEqual(parseKeySlots([recovery, passphrase]), [recovery, passphrase]);
});

test('parseKeySlots rejects the wrong number, duplicates and a missing passphrase slot', () => {
  rejects([], /1 to 4/);
  rejects('slots', /1 to 4/);
  rejects([passphrase, passphrase], /one slot of each kind/);
  rejects([recovery], /passphrase slot/);
  rejects([passphrase, recovery, { ...recovery }, { ...passphrase }, { ...recovery }], /1 to 4/);
});

test('parseKeySlots rejects unknown keys, kinds and malformed slots', () => {
  rejects([{ ...passphrase, extra: 1 }], /unknown key "extra"/);
  rejects([passphrase, { ...recovery, salt: 'x' }], /unknown key "salt"/);
  rejects([{ ...passphrase, kind: 'passkey' }], /kind/);
  rejects([null], /JSON object/);
  rejects([{ ...passphrase, kdf: 'scrypt' }], /kdf/);
  rejects([{ ...passphrase, wrapped: 'abw1.AAAA' }], /wrapped/);
  rejects([{ ...passphrase, wrapped: 42 }], /wrapped/);
});

test('parseKeySlots bounds the kdf cost and the salt', () => {
  for (const bad of [
    { m: 1024 },
    { m: 262_145 },
    { m: 65536.5 },
    { m: '65536' },
    { t: 0 },
    { t: 11 },
    { p: 0 },
    { p: 5 },
  ])
    rejects([{ ...passphrase, ...bad }], /must be a whole number/);
  assert.equal(parseKeySlots([{ ...passphrase, m: 262_144, t: 10, p: 4 }]).length, 1);
  rejects([{ ...passphrase, salt: 'A'.repeat(21) }], /salt/);
  rejects([{ ...passphrase, salt: 'A'.repeat(87) }], /salt/);
  rejects([{ ...passphrase, salt: `${'A'.repeat(21)}+` }], /salt/);
  assert.equal(parseKeySlots([{ ...passphrase, salt: 'A'.repeat(86) }]).length, 1);
});

test('parseKeySetup needs a 16 hex character key id', () => {
  const setup = { keyId: '0573c0a7b6879764', slots: [passphrase] };
  assert.deepEqual(parseKeySetup(setup), setup);
  for (const keyId of ['', '0573C0A7B6879764', '0573c0a7b687976', '0573c0a7b68797644', 'zzzzzzzzzzzzzzzz'])
    assert.throws(() => parseKeySetup({ ...setup, keyId }), ContractError);
  assert.throws(() => parseKeySetup({ ...setup, extra: 1 }), ContractError);
  assert.throws(() => parseKeySetup(null), ContractError);
  assert.ok(isKeyId('0573c0a7b6879764'));
  assert.ok(!isKeyId(5));
});
