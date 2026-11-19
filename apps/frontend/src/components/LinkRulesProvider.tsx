import { useQuery } from '@tanstack/react-query';
import { useMemo, type PropsWithChildren } from 'react';
import { LinkRulesContext } from '../lib/linkRulesContext';
import { useTRPC } from '../lib/trpc';

/**
 * Gives the markdown below it the user's link rules. Without rules (none saved, still loading, failed to load or not
 * readable with the key) a text renders without extra links; the settings page says which of these it is.
 */
export function LinkRulesProvider({ children }: PropsWithChildren) {
  const trpc = useTRPC();
  const links = useQuery(trpc.links.get.queryOptions());
  const rules = links.data?.rules;
  const value = useMemo(() => rules ?? [], [rules]);
  return <LinkRulesContext.Provider value={value}>{children}</LinkRulesContext.Provider>;
}
