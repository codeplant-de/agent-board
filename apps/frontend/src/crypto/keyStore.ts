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

const toStored = ({ owner, keyId, enc, transcript }: Keys): StoredKeys => ({ owner, keyId, enc, transcript });

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

export function createMemoryKeyStore(initial?: Keys): KeyStore {
  let entry = initial && toStored(initial);
  return {
    load: async () => entry,
    save: async (keys) => {
      entry = toStored(keys);
    },
    clear: async () => {
      entry = undefined;
    },
  };
}

/** The stored keys when they belong to this user and this key id; any other entry is deleted. */
export async function loadUsableKeys(
  store: KeyStore,
  me: { username: string; keyId: string | null },
): Promise<Keys | undefined> {
  const stored = await store.load();
  if (stored === undefined) return undefined;
  const usable =
    me.keyId !== null &&
    stored.owner === me.username &&
    stored.keyId === me.keyId &&
    isCryptoKey(stored.enc) &&
    isCryptoKey(stored.transcript);
  if (!usable) {
    await store.clear();
    return undefined;
  }
  return { owner: stored.owner, keyId: stored.keyId, enc: stored.enc, transcript: stored.transcript };
}
