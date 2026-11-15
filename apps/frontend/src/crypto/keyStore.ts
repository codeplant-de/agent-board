import type { Keys } from '@agent-board/shared';

/** What is kept between visits: the derived keys, never the data key or the passphrase. */
export interface StoredKeys {
  owner: string;
  keyId: string;
  enc: CryptoKey;
  transcript: CryptoKey;
}

export interface KeyStore {
  load(): Promise<StoredKeys | undefined>;
  save(keys: Keys): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = 'agent-board-keys';
const STORE = 'keys';
const ENTRY = 'current';

const isCryptoKey = (value: unknown): boolean => typeof value === 'object' && value !== null && 'algorithm' in value;

/** The part of `keys` that is kept: the derived keys without the index key. */
export const toStored = ({ owner, keyId, enc, transcript }: Keys): StoredKeys => ({ owner, keyId, enc, transcript });

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function open(): Promise<IDBDatabase> {
  const opening = indexedDB.open(DB_NAME, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(STORE);
  return request(opening);
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await request(run(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

/**
 * The browser's IndexedDB. A non-extractable `CryptoKey` can be stored as it is, so the page can use the keys but no script
 * can read their bytes. Where storage is blocked (a private window) it does nothing, and the keys last for the visit.
 */
export function createIndexedDbKeyStore(): KeyStore {
  return {
    async load() {
      try {
        return await withStore<StoredKeys | undefined>('readonly', (store) => store.get(ENTRY));
      } catch {
        return undefined;
      }
    },
    async save(keys) {
      try {
        await withStore('readwrite', (store) => store.put(toStored(keys), ENTRY));
      } catch {
        // The keys stay in memory for this visit.
      }
    },
    async clear() {
      try {
        await withStore('readwrite', (store) => store.delete(ENTRY));
      } catch {
        // Nothing was stored.
      }
    },
  };
}

/** What this browser holds, set against what the board says about the user. */
export type StoredKeysCheck =
  | { kind: 'none' }
  | { kind: 'usable'; keys: Keys }
  // The browser holds keys, and the board reports no key, another key id or another user. Nothing is deleted: that would be what
  // a board wants that is walking the user into setting up a second key while their machines keep the first.
  | { kind: 'changed'; held: { owner: string; keyId: string } };

/**
 * The stored keys when they are this user's and have the key id the board reports. An entry that is not is kept and reported
 * as `changed`; only an entry that is damaged (not keys at all) is dropped.
 */
export async function inspectStoredKeys(
  store: KeyStore,
  me: { username: string; keyId: string | null },
): Promise<StoredKeysCheck> {
  const stored = await store.load();
  if (stored === undefined) return { kind: 'none' };
  if (!isCryptoKey(stored.enc) || !isCryptoKey(stored.transcript)) {
    await store.clear();
    return { kind: 'none' };
  }
  if (me.keyId === null || stored.owner !== me.username || stored.keyId !== me.keyId)
    return { kind: 'changed', held: { owner: stored.owner, keyId: stored.keyId } };
  return {
    kind: 'usable',
    keys: { owner: stored.owner, keyId: stored.keyId, enc: stored.enc, transcript: stored.transcript },
  };
}
