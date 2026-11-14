import type { Keys } from '@agent-board/shared';
import { Center, Loader } from '@mantine/core';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState, type PropsWithChildren } from 'react';
import { useTRPC } from '../lib/trpc';
import { createIndexedDbKeyStore, loadUsableKeys, type KeyStore } from './keyStore';
import { KeyProvider } from './KeyProvider';
import { SetupScreen } from './SetupScreen';
import { UnlockScreen } from './UnlockScreen';

const defaultStore = createIndexedDbKeyStore();

interface Props {
  me: { username: string; keyId: string | null };
  store?: KeyStore;
}

/** What the gate's own screens read; everything else in the cache is decrypted board content. */
const isBoardQuery = (queryKey: readonly unknown[]): boolean => {
  const path = queryKey[0];
  const root = Array.isArray(path) ? path[0] : undefined;
  return root !== 'me' && root !== 'keys';
};

const dropBoard = (queryClient: QueryClient): void =>
  queryClient.removeQueries({ predicate: (query) => isBoardQuery(query.queryKey) });

/**
 * Between the sign-in and the app: no key yet means setup, no usable key in this browser means unlock, and only then the
 * app, with the keys in context. A stored key counts only when it is this user's and has the board's key id.
 */
export function KeyGate({ me, store = defaultStore, children }: PropsWithChildren<Props>) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const { username, keyId } = me;
  const identity = `${username}\0${keyId ?? ''}`;
  const [loaded, setLoaded] = useState<{ identity: string; keys: Keys | null }>();

  useEffect(() => {
    let current = true;
    void loadUsableKeys(store, { username, keyId }).then((keys) => {
      if (current) setLoaded({ identity, keys: keys ?? null });
    });
    return () => {
      current = false;
    };
  }, [store, username, keyId, identity]);

  const unlocked = useCallback(
    async (keys: Keys) => {
      await store.save(keys);
      setLoaded({ identity: `${username}\0${keys.keyId}`, keys });
    },
    [store, username],
  );
  const setUp = useCallback(
    async (keys: Keys) => {
      await unlocked(keys);
      await queryClient.invalidateQueries({ queryKey: trpc.me.queryKey() });
    },
    [unlocked, queryClient, trpc],
  );
  const lock = useCallback(async () => {
    await store.clear();
    setLoaded({ identity, keys: null });
    dropBoard(queryClient);
  }, [store, identity, queryClient]);

  if (keyId === null) return <SetupScreen owner={username} onComplete={setUp} />;
  const keys = loaded?.identity === identity ? loaded.keys : undefined;
  if (keys === undefined)
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  if (keys === null) return <UnlockScreen owner={username} onUnlocked={unlocked} />;
  return (
    <KeyProvider keys={keys} lock={lock}>
      {children}
    </KeyProvider>
  );
}
