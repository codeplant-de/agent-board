// The browser's real tRPC layer over HTTP, for tests that run it against the real server: the cache, the queries and the mutations
// are the ones the pages use, with nothing sealing or opening in their place, and the requests are the ones the browser sends
// (the tRPC HTTP protocol over `fetch`), so the server's adapter, its sign-in check and the JSON encoding are exercised.
import type { AppRouter } from '@agent-board/backend/router';
import type { Keys } from '@agent-board/shared';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { createPlainTRPC } from '../lib/plainTrpc';

export interface BrowserHarness {
  trpc: ReturnType<typeof createPlainTRPC>;
  fetchQuery: <T>(options: { queryKey: readonly unknown[] }) => Promise<T>;
  mutate: <V, R>(options: { mutationFn?: unknown }, variables: V) => Promise<R>;
}

/** `fetch` answers a request as the board's web container would; a test hands one that reaches its server (or a hostile one). */
export function createBrowserHarness(options: {
  keys: Keys | null;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;
}): BrowserHarness {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: 'https://board.test/trpc',
        fetch: (input, init) =>
          options.fetch(String(input instanceof Request ? input.url : input), {
            method: init?.method ?? 'GET',
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            ...(typeof init?.body === 'string' ? { body: init.body } : {}),
          }),
      }),
    ],
  });
  const trpc = createPlainTRPC(createTRPCOptionsProxy<AppRouter>({ client, queryClient }), client, options.keys);
  return {
    trpc,
    fetchQuery: <T>(query: { queryKey: readonly unknown[] }) =>
      queryClient.fetchQuery({ ...query, staleTime: 0 } as never) as Promise<T>,
    mutate: <V, R>(mutation: { mutationFn?: unknown }, variables: V) =>
      new MutationObserver<R, Error, V>(queryClient, mutation as never).mutate(variables),
  };
}
