import { createContext, useContext } from 'react';

/** Called once the board has deleted the account: everything that talks to the board is gone after it. */
export const AccountDeletedContext = createContext<(() => void) | null>(null);

export function useAccountDeleted(): () => void {
  const markDeleted = useContext(AccountDeletedContext);
  if (markDeleted === null) throw new Error('useAccountDeleted needs an AccountDeletedProvider');
  return markDeleted;
}
