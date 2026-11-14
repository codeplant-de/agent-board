import type { AppRouter } from '@agent-board/backend/router';
import { notifications } from '@mantine/notifications';
import { MutationCache, QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink, TRPCClientError } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';

export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
export type BoardTask = RouterOutputs['tasks']['get']['task'];
/** A task on the board: with its newest note. */
export type ListedTask = RouterOutputs['tasks']['list'][number];
export type LastNote = NonNullable<ListedTask['lastNote']>;
export type ThreadNote = RouterOutputs['tasks']['get']['thread'][number];

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

export const errorMessage = (err: unknown): string => {
  if (err instanceof TRPCClientError) {
    const issues = (err.data as { zodIssues?: { message: string }[] } | undefined)?.zodIssues;
    if (issues?.length) return issues.map((i) => i.message).join(', ');
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
};

/** Workers change the board from elsewhere, so open views poll. */
export const POLL_MS = 5_000;

export function createClients() {
  const queryClient: QueryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 2_000, refetchOnWindowFocus: true, retry: 1 },
    },
    // Every write may change the board, the task page and the cards' last note, so refetch what is on screen.
    mutationCache: new MutationCache({
      onSuccess: (): Promise<void> => queryClient.invalidateQueries(),
      onError: (err) => notifications.show({ color: 'red', title: 'Failed', message: errorMessage(err) }),
    }),
  });
  const trpcClient = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: '/trpc' })],
  });
  return { queryClient, trpcClient };
}
