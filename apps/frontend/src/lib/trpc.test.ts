import { notifications } from '@mantine/notifications';
import { QueryObserver } from '@tanstack/react-query';
import { TRPCClientError } from '@trpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClients } from './trpc';
import { isUnauthorized } from './unauthorized';

const ME = [['me'], { type: 'query' }];

const failure = (code: string) =>
  TRPCClientError.from({
    error: { message: 'Sign in to use the board.', code: -32001, data: { code, httpStatus: 401 } },
  });

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the browser’s tRPC client', () => {
  it('sends no Authorization header and leaves the cookie to the browser’s same-origin default', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify([{ result: { data: null } }])),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { trpcClient } = createClients();
    await trpcClient.me.query();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(init?.credentials ?? 'same-origin').toBe('same-origin');
  });
});

describe('a session that ends while the app is open', () => {
  it('knows the board’s refusal by its code, not by its message', () => {
    expect(isUnauthorized(failure('UNAUTHORIZED'))).toBe(true);
    expect(isUnauthorized(failure('FORBIDDEN'))).toBe(false);
    expect(isUnauthorized(new Error('UNAUTHORIZED'))).toBe(false);
  });

  it('makes any refused query ask `me` again, which sends the app to the sign-in page, and does not retry it', async () => {
    const { queryClient } = createClients();
    const me = vi.fn(async () => ({ username: 'jascha' }));
    const watching = new QueryObserver(queryClient, { queryKey: ME, queryFn: me }).subscribe(() => undefined);
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(1));
    const tasks = vi.fn(async (): Promise<never> => {
      throw failure('UNAUTHORIZED');
    });
    await queryClient.fetchQuery({ queryKey: [['tasks', 'list']], queryFn: tasks }).catch(() => undefined);
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(2));
    expect(tasks).toHaveBeenCalledTimes(1);
    watching();
  });

  it('does the same for a refused mutation, without a failure toast', async () => {
    const show = vi.spyOn(notifications, 'show').mockReturnValue('id');
    const { queryClient } = createClients();
    const me = vi.fn(async () => ({ username: 'jascha' }));
    const watching = new QueryObserver(queryClient, { queryKey: ME, queryFn: me }).subscribe(() => undefined);
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(1));
    await queryClient
      .getMutationCache()
      .build(queryClient, {
        mutationFn: async (): Promise<never> => {
          throw failure('UNAUTHORIZED');
        },
      })
      .execute(undefined)
      .catch(() => undefined);
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(2));
    expect(show).not.toHaveBeenCalled();
    watching();
  });

  it('still shows a failure of a mutation that is not a refusal', async () => {
    const show = vi.spyOn(notifications, 'show').mockReturnValue('id');
    const { queryClient } = createClients();
    await queryClient
      .getMutationCache()
      .build(queryClient, {
        mutationFn: async (): Promise<never> => {
          throw failure('FORBIDDEN');
        },
      })
      .execute(undefined)
      .catch(() => undefined);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('does not loop when `me` itself is refused', async () => {
    const { queryClient } = createClients();
    const me = vi.fn(async (): Promise<never> => {
      throw failure('UNAUTHORIZED');
    });
    const watching = new QueryObserver(queryClient, { queryKey: ME, queryFn: me }).subscribe(() => undefined);
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(1));
    await new Promise((wait) => setTimeout(wait, 50));
    expect(me).toHaveBeenCalledTimes(1);
    watching();
  });
});
