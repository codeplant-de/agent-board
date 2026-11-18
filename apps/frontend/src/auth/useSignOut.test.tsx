import { notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { TRPCClientError } from '@trpc/client';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_MARKER_KEY } from '../lib/session';
import { useSignOut } from './useSignOut';

const logout = vi.hoisted(() => vi.fn());
const lock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../lib/trpc', () => ({
  errorMessage: (err: Error) => err.message,
  useRawTRPCClient: () => ({ auth: { logout: { mutate: logout } } }),
}));
vi.mock('../crypto/KeyContext', () => ({ useLock: () => lock }));
vi.mock('./useAuthConfig', () => ({ useAuthConfig: () => ({ data: { login: true } }) }));

const failure = (code: string, message: string) =>
  TRPCClientError.from({ error: { message, code: -32001, data: { code, httpStatus: 401 } } });

function setup() {
  const queryClient = new QueryClient();
  const resetQueries = vi.spyOn(queryClient, 'resetQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useSignOut(), { wrapper });
  return { signOut: result.current, resetQueries };
}

describe('useSignOut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('locks, tells the other tabs and resets the cache once the board ended the session', async () => {
    logout.mockResolvedValue(undefined);
    const { signOut, resetQueries } = setup();
    await signOut?.();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(SESSION_MARKER_KEY)).not.toBeNull();
    expect(resetQueries).toHaveBeenCalledTimes(1);
  });

  it('counts an answer of UNAUTHORIZED as signed out already', async () => {
    logout.mockRejectedValue(failure('UNAUTHORIZED', 'Sign in to use the board.'));
    const { signOut, resetQueries } = setup();
    await signOut?.();
    expect(lock).toHaveBeenCalledTimes(1);
    expect(resetQueries).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a server error', failure('INTERNAL_SERVER_ERROR', 'internal error')],
    ['an unreachable board', new TypeError('Failed to fetch')],
  ])('keeps the user signed in and shows the error after %s', async (_name, error) => {
    const show = vi.spyOn(notifications, 'show').mockReturnValue('id');
    logout.mockRejectedValue(error);
    const { signOut, resetQueries } = setup();
    await signOut?.();
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ color: 'red', message: expect.any(String) }));
    expect(lock).not.toHaveBeenCalled();
    expect(resetQueries).not.toHaveBeenCalled();
    expect(localStorage.getItem(SESSION_MARKER_KEY)).toBeNull();
  });
});
