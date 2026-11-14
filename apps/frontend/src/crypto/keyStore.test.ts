import { describe, expect, it } from 'vitest';
import { createKeySetup } from './keySlots';
import { createMemoryKeyStore, loadUsableKeys } from './keyStore';

async function keysFor(owner: string) {
  return (await createKeySetup({ owner, passphrase: 'correct horse battery staple', kdf: { m: 8192, t: 1, p: 1 } }))
    .keys;
}

describe('key store', () => {
  it('hands back keys that belong to this user and this key id', async () => {
    const keys = await keysFor('jascha');
    const store = createMemoryKeyStore(keys);
    const usable = await loadUsableKeys(store, { username: 'jascha', keyId: keys.keyId });
    expect(usable).toMatchObject({ owner: 'jascha', keyId: keys.keyId });
    expect(usable?.enc).toBe(keys.enc);
  });

  it('discards an entry made for another user', async () => {
    const keys = await keysFor('jascha');
    const store = createMemoryKeyStore(keys);
    expect(await loadUsableKeys(store, { username: 'someone-else', keyId: keys.keyId })).toBeUndefined();
    expect(await store.load()).toBeUndefined();
  });

  it('discards an entry for another key id', async () => {
    const keys = await keysFor('jascha');
    const store = createMemoryKeyStore(keys);
    expect(await loadUsableKeys(store, { username: 'jascha', keyId: '0123456789abcdef' })).toBeUndefined();
    expect(await store.load()).toBeUndefined();
  });

  it('discards an entry when the board has no key yet', async () => {
    const keys = await keysFor('jascha');
    const store = createMemoryKeyStore(keys);
    expect(await loadUsableKeys(store, { username: 'jascha', keyId: null })).toBeUndefined();
    expect(await store.load()).toBeUndefined();
  });

  it('keeps nothing but the derived keys and ids', async () => {
    const keys = await keysFor('jascha');
    const store = createMemoryKeyStore();
    await store.save(keys);
    expect(Object.keys((await store.load()) ?? {}).sort()).toEqual(['enc', 'keyId', 'owner', 'transcript']);
    await store.clear();
    expect(await store.load()).toBeUndefined();
  });
});
