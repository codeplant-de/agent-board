import type { Keys } from '@agent-board/shared';
import { useMemo, type PropsWithChildren } from 'react';
import { KeyContext } from './KeyContext';

interface Props {
  keys: Keys;
  lock: () => Promise<void>;
}

export function KeyProvider({ keys, lock, children }: PropsWithChildren<Props>) {
  const value = useMemo(() => ({ keys, lock }), [keys, lock]);
  return <KeyContext.Provider value={value}>{children}</KeyContext.Provider>;
}
