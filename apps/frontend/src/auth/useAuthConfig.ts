import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '../lib/trpc';

/** What the board offers for signing in. It rarely changes, so one answer serves the sign-in page, the header and Settings. */
export function useAuthConfig() {
  const trpc = useTRPC();
  return useQuery({ ...trpc.auth.config.queryOptions(), staleTime: 5 * 60_000 });
}
