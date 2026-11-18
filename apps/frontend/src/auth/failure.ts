import { TRPCClientError } from '@trpc/client';
import { errorMessage } from '../lib/trpc';

export const CANCELLED = 'The passkey prompt was cancelled.';

/** The browser's answer when the user dismisses the passkey prompt or it times out. */
export function isCancelled(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/** The text of a failed sign-in step: the server's own message, or the browser's. */
export function failureMessage(error: unknown): string {
  if (error instanceof TRPCClientError) return errorMessage(error);
  // `instanceof Error` misses an error from another realm, which the browser's own errors can be.
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message
    : String(error);
}
