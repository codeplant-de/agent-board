import type { Keys } from '@agent-board/shared';
import { createContext, useContext } from 'react';

export interface KeyContextValue {
  keys: Keys;
  /** Forgets the stored keys and the decrypted board, and asks for the passphrase again. */
  lock: () => Promise<void>;
}

export const KeyContext = createContext<KeyContextValue | null>(null);

/** The unlocked keys; null outside the unlocked app, where nothing sealed is opened or sent. */
export function useKeys(): Keys | null {
  return useContext(KeyContext)?.keys ?? null;
}

export function useLock(): (() => Promise<void>) | null {
  return useContext(KeyContext)?.lock ?? null;
}
