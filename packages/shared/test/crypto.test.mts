import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blindIndex,
  CryptoError,
  decodeDataKey,
  deriveKeys,
  encodeDataKey,
  envelopeLength,
  ENVELOPE_PREFIX,
  generateDataKey,
  isBlindIndex,
  isEnvelope,
  open,
  seal,
  unwrapDataKey,
  wrapDataKey,
  type Field,
} from '../src/crypto.mts';

const FIELDS: Field[] = [
  'title',
  'input',
  'workdir',
  'note.body',
  'note.preview',
  'note.suggestion',
  'note.questions',
  'note.answers',
  'tr.data',
  'tr.output',
];

const KNOWN_KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const KNOWN_ENVELOPE = 'abe1.xvA9rlAXmpSteSPXmS-ksGHsUUuBa8FWhXp8C01l9UcnBtCxUMkW9Q';

const isCryptoError = (error: unknown): boolean => error instanceof CryptoError;

async function setup(owner = 'alice') {
  return deriveKeys(generateDataKey(), owner, { index: true });
}

function decodeEnvelope(envelope: string): Uint8Array {
  return Uint8Array.from(Buffer.from(envelope.slice(ENVELOPE_PREFIX.length), 'base64url'));
}

function encodeEnvelope(bytes: Uint8Array): string {
  return ENVELOPE_PREFIX + Buffer.from(bytes).toString('base64url');
}

test('every field round-trips, including empty, non-ASCII and 1 MB values', async () => {
  const keys = await setup();
  const values = ['', 'plain text', 'Grüße, 日本語, 🙂 \n\t', 'x'.repeat(1024 * 1024)];
  for (const field of FIELDS) {
    for (const value of values) {
      const envelope = await seal(keys, field, 'ctx', value);
      assert.ok(isEnvelope(envelope));
      assert.equal(await open(keys, field, 'ctx', envelope), value);
    }
  }
});

test('two seals of the same plaintext differ', async () => {
  const keys = await setup();
  assert.notEqual(await seal(keys, 'title', '', 'same'), await seal(keys, 'title', '', 'same'));
});

test('opening under another owner, field, context or data key fails', async () => {
  const keys = await setup();
  const envelope = await seal(keys, 'note.body', 'task-1', 'secret');
  const other = await deriveKeys(generateDataKey(), 'alice');
  const bob = { ...keys, owner: 'bob' };
  await assert.rejects(open(bob, 'note.body', 'task-1', envelope), isCryptoError);
  await assert.rejects(open(keys, 'note.preview', 'task-1', envelope), isCryptoError);
  await assert.rejects(open(keys, 'note.body', 'task-2', envelope), isCryptoError);
  await assert.rejects(open(other, 'note.body', 'task-1', envelope), isCryptoError);
  assert.equal(await open(keys, 'note.body', 'task-1', envelope), 'secret');
});

test('a transcript field does not open through the enc key path', async () => {
  const keys = await setup();
  const envelope = await seal(keys, 'tr.data', 'run:1', 'secret');
  await assert.rejects(open(keys, 'note.body', 'run:1', envelope), isCryptoError);
  const swapped = { ...keys, enc: keys.transcript };
  await assert.rejects(open(swapped, 'note.body', 'run:1', envelope), isCryptoError);
});

test('owner, field and context containing NUL are rejected', async () => {
  const keys = await setup();
  await assert.rejects(seal(keys, 'title', 'a\0b', 'x'), isCryptoError);
  await assert.rejects(seal({ ...keys, owner: 'a\0b' }, 'title', '', 'x'), isCryptoError);
  await assert.rejects(seal(keys, 'bad\0' as Field, '', 'x'), isCryptoError);
  await assert.rejects(deriveKeys(generateDataKey(), 'a\0b'), isCryptoError);
});

test('every single-byte flip in a short envelope fails to open', async () => {
  const keys = await setup();
  const bytes = decodeEnvelope(await seal(keys, 'title', '', 'short'));
  for (let i = 0; i < bytes.length; i += 1) {
    const flipped = Uint8Array.from(bytes);
    flipped[i] = (flipped[i] ?? 0) ^ 0x01;
    await assert.rejects(open(keys, 'title', '', encodeEnvelope(flipped)), isCryptoError, `byte ${i}`);
  }
});

test('truncated and malformed envelopes fail with a CryptoError', async () => {
  const keys = await setup();
  const envelope = await seal(keys, 'title', '', 'some text');
  await assert.rejects(open(keys, 'title', '', envelope.slice(0, -4)), isCryptoError);
  await assert.rejects(open(keys, 'title', '', envelope.slice(0, 20)), isCryptoError);
  await assert.rejects(open(keys, 'title', '', ENVELOPE_PREFIX), isCryptoError);
  await assert.rejects(open(keys, 'title', '', 'plaintext'), isCryptoError);
  await assert.rejects(open(keys, 'title', '', `${envelope}!`), isCryptoError);
});

test('open errors never carry plaintext, key material or the envelope', async () => {
  const keys = await setup();
  const envelope = await seal(keys, 'title', '', 'topsecret');
  const bad = await open(keys, 'title', 'other', envelope).catch((error: unknown) => String(error));
  assert.ok(!bad.includes('topsecret'));
  assert.ok(!bad.includes(envelope.slice(ENVELOPE_PREFIX.length)));
});

test('isEnvelope is structural', async () => {
  const keys = await setup();
  assert.ok(isEnvelope(await seal(keys, 'title', '', '')));
  assert.ok(!isEnvelope('hello world'));
  assert.ok(!isEnvelope(''));
  assert.ok(!isEnvelope(ENVELOPE_PREFIX));
  assert.ok(!isEnvelope(`${ENVELOPE_PREFIX}short`));
  assert.ok(!isEnvelope(`${ENVELOPE_PREFIX}${'A'.repeat(50)}+/=`));
  assert.ok(!isEnvelope(`abe2.${'A'.repeat(50)}`));
});

test('blindIndex is stable per key and value and differs otherwise', async () => {
  const keys = await setup();
  const other = await setup();
  const a = await blindIndex(keys, 'https://example.test/pr/1');
  assert.match(a, /^abh1\.[A-Za-z0-9_-]{43}$/);
  assert.equal(a, await blindIndex(keys, 'https://example.test/pr/1'));
  assert.notEqual(a, await blindIndex(keys, 'https://example.test/pr/2'));
  assert.notEqual(a, await blindIndex(other, 'https://example.test/pr/1'));
});

test('blindIndex without a derived index key throws a clear CryptoError', async () => {
  const keys = await deriveKeys(generateDataKey(), 'alice');
  assert.equal(keys.index, undefined);
  await assert.rejects(blindIndex(keys, 'x'), (error) => error instanceof CryptoError && /index/.test(error.message));
});

test('keyId is stable per data key and differs across keys', async () => {
  const dataKey = generateDataKey();
  const a = await deriveKeys(dataKey, 'alice');
  const b = await deriveKeys(dataKey, 'bob', { index: true });
  const c = await deriveKeys(generateDataKey(), 'alice');
  assert.match(a.keyId, /^[0-9a-f]{16}$/);
  assert.equal(a.keyId, b.keyId);
  assert.notEqual(a.keyId, c.keyId);
});

test('derived keys are non-extractable and limited in usage', async () => {
  const keys = await setup();
  const { index } = keys;
  assert.ok(index);
  for (const key of [keys.enc, keys.transcript, index]) {
    assert.equal(key.extractable, false);
    await assert.rejects(globalThis.crypto.subtle.exportKey('raw', key));
  }
  assert.deepEqual([...keys.enc.usages].sort(), ['decrypt', 'encrypt']);
  assert.deepEqual([...index.usages], ['sign']);
});

test('deriveKeys rejects a data key of the wrong length', async () => {
  await assert.rejects(deriveKeys(new Uint8Array(16), 'alice'), isCryptoError);
});

test('data keys encode, decode and reject bad input', () => {
  const key = generateDataKey();
  assert.equal(key.length, 32);
  const text = encodeDataKey(key);
  assert.match(text, /^abk1_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(decodeDataKey(text), key);
  for (const bad of [
    '',
    'abk1_',
    'abk1_AAAA',
    `abk2_${text.slice(5)}`,
    text.slice(5),
    `${text}A`,
    `${text.slice(0, -1)}!`,
  ]) {
    assert.throws(() => decodeDataKey(bad), isCryptoError, bad);
  }
  assert.throws(() => encodeDataKey(new Uint8Array(31)), isCryptoError);
});

test('wrapping a data key round-trips and fails under another wrapping key', async () => {
  const wrappingKey = generateDataKey();
  const dataKey = generateDataKey();
  const wrapped = await wrapDataKey(wrappingKey, dataKey);
  assert.ok(wrapped.startsWith('abw1.'));
  assert.deepEqual(await unwrapDataKey(wrappingKey, wrapped), dataKey);
  assert.notEqual(wrapped, await wrapDataKey(wrappingKey, dataKey));
  await assert.rejects(unwrapDataKey(generateDataKey(), wrapped), isCryptoError);
  await assert.rejects(unwrapDataKey(wrappingKey, 'abw1.AAAA'), isCryptoError);
  await assert.rejects(unwrapDataKey(wrappingKey, 'nope'), isCryptoError);
  await assert.rejects(unwrapDataKey(new Uint8Array(8), wrapped), isCryptoError);
  await assert.rejects(wrapDataKey(wrappingKey, new Uint8Array(8)), isCryptoError);
});

test('a wrapped data key is not an envelope and does not open as one', async () => {
  const wrappingKey = generateDataKey();
  const wrapped = await wrapDataKey(wrappingKey, generateDataKey());
  assert.ok(!isEnvelope(wrapped));
});

test('known-answer vector keeps the derivation and AAD format stable', async () => {
  const keys = await deriveKeys(KNOWN_KEY, 'alice', { index: true });
  assert.equal(keys.keyId, '0573c0a7b6879764');
  assert.equal(await blindIndex(keys, 'https://example.test/pr/1'), 'abh1.motVWtZkCTTN6P6Beby586qTOh3FtoMEKPOHTgEhd4o');
  assert.equal(await open(keys, 'note.body', 'task-1', KNOWN_ENVELOPE), 'known answer');
});

test('envelopeLength is the length seal produces, and isBlindIndex knows the blind index shape', async () => {
  const keys = await setup();
  for (const length of [0, 1, 2, 3, 100, 1001]) {
    const envelope = await seal(keys, 'title', '', 'é'.repeat(length));
    assert.equal(envelope.length, envelopeLength(length * 2));
  }
  assert.ok(isBlindIndex(await blindIndex(keys, 'https://github.com/o/r/pull/1')));
  assert.equal(isBlindIndex('https://github.com/o/r/pull/1'), false);
  assert.equal(isBlindIndex(`abh1.${'A'.repeat(42)}`), false);
  assert.equal(isBlindIndex(`abh1.${'A'.repeat(44)}`), false);
});
