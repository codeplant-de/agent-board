import { TRPCClientError } from '@trpc/client';

/** The board refused a call because nobody is signed in, or the session has ended. */
export function isUnauthorized(error: unknown): boolean {
  return (
    error instanceof TRPCClientError && (error.data as { code?: string } | null | undefined)?.code === 'UNAUTHORIZED'
  );
}
