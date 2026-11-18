import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { challengeOf } from '../services/auth/flows';

export interface RpcAnswer<T> {
  status: number;
  /** The procedure's output, when it succeeded. */
  data: T | undefined;
  /** The tRPC error code, when it failed. */
  code: string | undefined;
  message: string | undefined;
  /** Every `Set-Cookie` header of the answer. */
  setCookies: string[];
  /** The session token a `Set-Cookie` of the answer carries, when it is not a clearing one. */
  sessionToken: string | undefined;
}

/** The name of the session cookie on the test boards, which are served over http. */
export const SESSION_COOKIE = 'board-session';

/** One tRPC call over HTTP, the way the browser makes it (no batching): a query goes in the URL, a mutation (the default) in the body. `token` goes as the session cookie; `cookie` is a raw `Cookie` header. */
export async function rpc<T = unknown>(
  app: FastifyInstance,
  path: string,
  input?: unknown,
  options: { token?: string; cookie?: string; type?: 'query' | 'mutation' } = {},
): Promise<RpcAnswer<T>> {
  const cookie = options.cookie ?? (options.token ? `${SESSION_COOKIE}=${options.token}` : undefined);
  const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
  const mutation = options.type !== 'query';
  const answer = mutation
    ? await app.inject({
        method: 'POST',
        url: `/trpc/${path}`,
        headers: { ...headers, 'content-type': 'application/json' },
        payload: JSON.stringify(input ?? null),
      })
    : await app.inject({
        method: 'GET',
        url: `/trpc/${path}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
        headers,
      });
  const json = answer.json() as { result?: { data: T }; error?: { message: string; data: { code: string } } };
  const setCookies = [answer.headers['set-cookie'] ?? []].flat();
  return {
    status: answer.statusCode,
    data: json.result?.data,
    code: json.error?.data.code,
    message: json.error?.message,
    setCookies,
    sessionToken: setCookies
      .map((value) => new RegExp(`^${SESSION_COOKIE}=(abs_[^;]+)`).exec(value)?.[1])
      .find(Boolean),
  };
}

/** A fresh verifier and the challenge a browser would send for it. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: challengeOf(verifier) };
}
