import { isEnvelope } from '@agent-board/shared';
import { AppError } from './errors';

/** The server never stores client text it could read: a value that is present must be an envelope. */
export function requireSealed(value: string | null | undefined, what: string): void {
  if (value !== null && value !== undefined && !isEnvelope(value))
    throw new AppError('BAD_REQUEST', `${what} must be encrypted`);
}
