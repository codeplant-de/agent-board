import type { Config, LoginConfig } from '../../config';
import type { Db } from '../../db/client';
import { AppError } from '../errors';
import type { OidcClient } from './oidc';

export interface AuthLog {
  warn(context: { err: unknown }, message: string): void;
}

/** What the sign-in services need, besides their own input. */
export interface AuthEnv {
  root: Db;
  login: LoginConfig;
  log: AuthLog;
  oidc: OidcClient;
}

export function loginOf(config: Config): LoginConfig {
  if (!config.auth.login) throw new AppError('NOT_FOUND', 'This board runs without login.');
  return config.auth;
}

/** The detail goes to the log; the caller learns only that the sign-in failed. */
export function signInFailed(log: AuthLog, err: unknown, message: string): AppError {
  if (err instanceof AppError) return err;
  log.warn({ err }, message);
  return new AppError('UNAUTHORIZED', 'Sign-in failed.');
}
