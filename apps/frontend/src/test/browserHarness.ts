// The browser's real tRPC layer over a link of the caller's own, for tests that run it against the real router: the cache,
// the queries and the mutations are the ones the pages use, with nothing sealing or opening in their place.
import type { AppRouter } from '@agent-board/backend/router';
import type { Keys } from '@agent-board/shared';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { observable } from '@trpc/server/observable';
import { createPlainTRPC } from '../lib/plainTrpc';

export interface BrowserHarness {
  trpc: ReturnType<typeof createPlainTRPC>;
  fetchQuery: <T>(options: { queryKey: readonly unknown[] }) => Promise<T>;
  mutate: <V, R>(options: { mutationFn?: unknown }, variables: V) => Promise<R>;
}

/**
 * `call` answers a procedure by its dotted path (`tasks.get`), input and type, as the server would; what it returns goes through
 * JSON, as on the wire, before the browser sees it. `seeing` may rewrite an answer, as a hostile server would.
 */
export function createBrowserHarness(options: {
  keys: Keys | null;
  call: (path: string, input: unknown, type: 'query' | 'mutation' | 'subscription') => Promise<unknown>;
  seeing?: (path: string, data: unknown) => unknown;
  sent?: (path: string, input: unknown) => void;
}): BrowserHarness {
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        options.sent?.(op.path, op.input);
        options.call(op.path, op.input, op.type).then(
          (data) => {
            const wire: unknown = data === undefined ? null : JSON.parse(JSON.stringify(data));
            observer.next({ result: { data: options.seeing?.(op.path, wire) ?? wire } });
            observer.complete();
          },
          (error: Error) => observer.error(TRPCClientError.from(error)),
        );
      });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTRPCClient<AppRouter>({ links: [link] });
  const trpc = createPlainTRPC(createTRPCOptionsProxy<AppRouter>({ client, queryClient }), client, options.keys);
  return {
    trpc,
    fetchQuery: <T>(query: { queryKey: readonly unknown[] }) =>
      queryClient.fetchQuery({ ...query, staleTime: 0 } as never) as Promise<T>,
    mutate: <V, R>(mutation: { mutationFn?: unknown }, variables: V) =>
      new MutationObserver<R, Error, V>(queryClient, mutation as never).mutate(variables),
  };
}
