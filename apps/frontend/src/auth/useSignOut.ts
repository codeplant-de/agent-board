import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useLock } from '../crypto/KeyContext';
import { useRawTRPCClient } from '../lib/trpc';
import { markSessionChanged } from '../lib/session';
import { isUnauthorized } from '../lib/unauthorized';
import { failureMessage } from './failure';
import { useAuthConfig } from './useAuthConfig';

/**
 * Ends the session on the board and on this device, which is left with no unlocked key; if the board cannot end it, the
 * user stays signed in and is told. Null where the board has no sign-in, so there is nothing to offer.
 */
export function useSignOut(): (() => Promise<void>) | null {
  const client = useRawTRPCClient();
  const queryClient = useQueryClient();
  const lock = useLock();
  const config = useAuthConfig();
  const signOut = useCallback(async () => {
    try {
      await client.auth.logout.mutate();
    } catch (err) {
      // An ended session is signed out already. Any other failure leaves the session alive on the board, so the user stays signed in and sees it.
      if (!isUnauthorized(err)) {
        notifications.show({ color: 'red', title: 'Sign-out failed', message: failureMessage(err) });
        return;
      }
    }
    await lock?.();
    markSessionChanged();
    await queryClient.resetQueries();
  }, [client, queryClient, lock]);
  return config.data?.login === true ? signOut : null;
}
