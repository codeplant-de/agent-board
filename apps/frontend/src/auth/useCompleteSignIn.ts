import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { markSessionChanged } from '../lib/session';
import { takeReturnPath } from './returnPath';

/**
 * What every sign-in ends with: tell the other tabs, drop what the cache holds of a signed-out board (the keys in IndexedDB are
 * left alone, so the same user is not asked for the passphrase again), and go back to where the user first asked to go.
 */
export function useCompleteSignIn(): () => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useCallback(async () => {
    markSessionChanged();
    await queryClient.resetQueries();
    navigate(takeReturnPath(), { replace: true });
  }, [queryClient, navigate]);
}
