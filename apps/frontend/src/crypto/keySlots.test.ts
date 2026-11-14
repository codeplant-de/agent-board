import { decodeDataKey, deriveKeys, parseKeySetup, type Keys } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { KeyError, PRODUCTION_KDF, WrongSecretError, type KdfParams } from './kdf';
import { createKeySetup, exportDataKey, replacePassphrase, unlockKeys } from './keySlots';
import { passphraseProblem } from './passphrase';
import { openAs, sealAs, taskFields } from '../lib/contexts';

// The smallest cost the board accepts; the production cost is for one test below.
const FAST: KdfParams = { m: 8192, t: 1, p: 1 };
const OWNER = 'jascha';
const PASSPHRASE = 'correct horse battery staple';

async function roundTrip(keys: Keys) {
  return openAs(keys, taskFields().title, await sealAs(keys, taskFields().title, 'hello'));
}

describe('key setup', () => {
  it('stores a passphrase slot and a recovery slot that the board accepts', async () => {
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    expect(parseKeySetup(setup)).toEqual(setup);
    expect(setup.slots.map((slot) => slot.kind)).toEqual(['passphrase', 'recovery']);
  });

  it('uses the production Argon2id cost unless told otherwise', async () => {
    expect(PRODUCTION_KDF).toEqual({ m: 65_536, t: 3, p: 1 });
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE });
    expect(setup.slots[0]).toMatchObject({ kind: 'passphrase', kdf: 'argon2id', m: 65_536, t: 3, p: 1 });
  }, 60_000);

  it('unlocks with the passphrase to the keys it made', async () => {
    const { setup, keys } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    const unlocked = await unlockKeys({
      owner: OWNER,
      stored: setup,
      secret: { kind: 'passphrase', passphrase: PASSPHRASE },
    });
    expect(unlocked.keyId).toBe(keys.keyId);
    expect(keys.keyId).toBe(setup.keyId);
    expect(await openAs(unlocked, taskFields().title, await sealAs(keys, taskFields().title, 'hello'))).toBe('hello');
  });

  it('unlocks with the recovery key as it was shown', async () => {
    const { setup, keys, recoveryKey } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    const unlocked = await unlockKeys({ owner: OWNER, stored: setup, secret: { kind: 'recovery', recoveryKey } });
    expect(await openAs(unlocked, taskFields().title, await sealAs(keys, taskFields().title, 'hello'))).toBe('hello');
  });

  it('gives non-extractable keys', async () => {
    const { keys } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    expect(keys.enc.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('raw', keys.enc)).rejects.toThrow();
  });

  it('refuses a wrong passphrase and a wrong recovery key without saying which part was wrong', async () => {
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    const other = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    await expect(
      unlockKeys({ owner: OWNER, stored: setup, secret: { kind: 'passphrase', passphrase: 'not the passphrase' } }),
    ).rejects.toBeInstanceOf(WrongSecretError);
    await expect(
      unlockKeys({ owner: OWNER, stored: setup, secret: { kind: 'recovery', recoveryKey: other.recoveryKey } }),
    ).rejects.toBeInstanceOf(WrongSecretError);
    await expect(
      unlockKeys({ owner: OWNER, stored: setup, secret: { kind: 'passphrase', passphrase: 'x' } }),
    ).rejects.toThrow('Wrong passphrase or recovery key.');
  });

  it('refuses a key id that is not the board’s', async () => {
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    await expect(
      unlockKeys({
        owner: OWNER,
        stored: { ...setup, keyId: '0000000000000000' },
        secret: { kind: 'passphrase', passphrase: PASSPHRASE },
      }),
    ).rejects.toBeInstanceOf(KeyError);
  });

  it.each([
    ['m', { m: 262_145, t: 1, p: 1 }],
    ['m below the floor', { m: 1024, t: 1, p: 1 }],
    ['t', { m: 8192, t: 11, p: 1 }],
    ['p', { m: 8192, t: 1, p: 5 }],
  ])('refuses slot parameters outside the limits (%s) before computing anything', async (_name, params) => {
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    const [slot, recovery] = setup.slots;
    const hostile = { ...setup, slots: [{ ...slot, ...params }, recovery] } as typeof setup;
    const started = Date.now();
    await expect(
      unlockKeys({ owner: OWNER, stored: hostile, secret: { kind: 'passphrase', passphrase: PASSPHRASE } }),
    ).rejects.toThrow('more computing than this browser accepts');
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('a new passphrase', () => {
  it('after the recovery key replaces the passphrase slot and keeps the recovery slot as it was', async () => {
    const { setup, recoveryKey, keys } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    const newPassphrase = 'a different long passphrase';
    const replaced = await replacePassphrase({
      owner: OWNER,
      stored: setup,
      secret: { kind: 'recovery', recoveryKey },
      newPassphrase,
      kdf: FAST,
    });
    const stored = { keyId: setup.keyId, slots: replaced.slots };
    expect(parseKeySetup(stored)).toEqual(stored);
    expect(replaced.slots.map((slot) => slot.kind)).toEqual(['passphrase', 'recovery']);
    expect(replaced.slots[1]).toEqual(setup.slots[1]);
    expect(replaced.slots[0]).not.toEqual(setup.slots[0]);
    expect(replaced.keys.keyId).toBe(keys.keyId);

    await expect(
      unlockKeys({ owner: OWNER, stored, secret: { kind: 'passphrase', passphrase: PASSPHRASE } }),
    ).rejects.toBeInstanceOf(WrongSecretError);
    expect(
      await roundTrip(
        await unlockKeys({ owner: OWNER, stored, secret: { kind: 'passphrase', passphrase: newPassphrase } }),
      ),
    ).toBe('hello');
    expect(await roundTrip(await unlockKeys({ owner: OWNER, stored, secret: { kind: 'recovery', recoveryKey } }))).toBe(
      'hello',
    );
  });

  it('is refused when the current passphrase is wrong', async () => {
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    await expect(
      replacePassphrase({
        owner: OWNER,
        stored: setup,
        secret: { kind: 'passphrase', passphrase: 'nope' },
        newPassphrase: 'a different long passphrase',
        kdf: FAST,
      }),
    ).rejects.toBeInstanceOf(WrongSecretError);
  });
});

describe('the data key for a machine', () => {
  it('is the abk1_ key that opens what the browser sealed', async () => {
    const { setup, keys } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    const line = await exportDataKey({ owner: OWNER, stored: setup, passphrase: PASSPHRASE });
    expect(line).toMatch(/^abk1_/);
    const machine = await deriveKeys(decodeDataKey(line), OWNER);
    expect(machine.keyId).toBe(keys.keyId);
    expect(await openAs(machine, taskFields().title, await sealAs(keys, taskFields().title, 'hello'))).toBe('hello');
  });

  it('needs the right passphrase', async () => {
    const { setup } = await createKeySetup({ owner: OWNER, passphrase: PASSPHRASE, kdf: FAST });
    await expect(exportDataKey({ owner: OWNER, stored: setup, passphrase: 'nope' })).rejects.toBeInstanceOf(
      WrongSecretError,
    );
  });
});

describe('passphrase strength', () => {
  it('asks for length and nothing else', () => {
    expect(passphraseProblem('short')).toMatch(/at least 14/);
    expect(passphraseProblem('              ')).toMatch(/at least 14/);
    expect(passphraseProblem('aaaaaaaaaaaaaa')).toBeNull();
    expect(passphraseProblem(PASSPHRASE)).toBeNull();
  });
});
