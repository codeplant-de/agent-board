import type { Keys } from '@agent-board/shared';
import { toStored, type KeyStore } from '../crypto/keyStore';

/** A key store that lives as long as the test, holding `initial` when given. */
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
