import { createHash, timingSafeEqual } from 'node:crypto';
import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import Fastify, { type FastifyRequest } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/client';
import { registerMachineApi, type MachineApiOptions } from './machine-api';
import { Changes, CHANGES_DEBOUNCE_MS } from './services/changes';
import { AppError, type AppErrorCode } from './services/errors';
import { appRouter, type AppRouter } from './trpc/router';

declare module 'fastify' {
  interface FastifyRequest {
    username: string | null;
  }
}

const header = (req: FastifyRequest, name: string): string | null => {
  const value = req.headers[name];
  const s = Array.isArray(value) ? value[0] : value;
  return s?.trim() || null;
};

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Who is using the UI. In production Traefik's Authelia forward-auth sets the Remote-* headers (and strips any
 * a client sends); locally DEV_AUTH_USER stands in. Any pod that reaches :4000 could set
 * Remote-* itself, so they count only together with PROXY_SECRET, which the web container's Caddy adds as
 * Board-Proxy-Secret. Null when the secret is missing or wrong, or the user is not in an allowed group.
 */
export function userFrom(req: FastifyRequest, config: Config): string | null {
  if (config.devAuthUser) return config.devAuthUser.toLowerCase();
  if (config.proxySecret) {
    const sent = header(req, 'board-proxy-secret');
    if (!sent || !timingSafeEqual(sha256(sent), sha256(config.proxySecret))) return null;
  }
  const username = header(req, 'remote-user');
  if (!username) return null;
  const groups = (header(req, 'remote-groups') ?? '').split(',').map((g) => g.trim());
  return groups.some((group) => config.allowedGroups.includes(group)) ? username.toLowerCase() : null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const STATUS: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
};

export interface ServerOptions extends Partial<MachineApiOptions> {
  /** How long writes of one owner are held back to give one event; tests shorten it. */
  debounceMs?: number;
  /** Tests hand in their own to look at it. */
  changes?: Changes;
}

export async function buildServer(config: Config, root: Db, options: ServerOptions = {}) {
  const changes = options.changes ?? new Changes(options.debounceMs ?? CHANGES_DEBOUNCE_MS);
  const app = Fastify({
    logger: config.nodeEnv === 'test' ? false : { level: 'info' },
    // The machine API sets its own limits per route; this is the UI's.
    bodyLimit: 16 * 1024 * 1024,
    // Behind the auth proxy: makes req.ip, which the request log writes as remoteAddress, the client's address, not the proxy's.
    trustProxy: true,
  });

  app.decorateRequest('username', null);
  app.addHook('onClose', async () => changes.close());
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(STATUS[err.code]).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    // Fastify's own 4xx (bad JSON, a too large body) are the client's fault; error is kept for server faults.
    if (status < 500) app.log.warn(err);
    else app.log.error(err);
    return reply.status(status).send({ error: status === 500 ? 'internal error' : (err as Error).message });
  });

  app.get('/healthz', async () => ({ ok: true }));

  // The machine API has its own tokens and is routed past the login; everything else needs a signed-in user.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz' || req.url.startsWith('/api/machine/')) return;
    req.username = userFrom(req, config);
    if (!req.username) return reply.status(403).send({ error: 'not allowed on this board' });
  });

  // tRPC's Fastify adapter takes multipart bodies, which a plain HTML form on a sibling subdomain can send with the user's
  // session cookie: SameSite does not stop a same-site request. Only the JSON the board's own client sends gets through;
  // a cross-origin JSON POST needs a CORS preflight, which this server never grants. The check goes by the matched route,
  // not the raw URL: Fastify routes on the decoded path, so `/%74rpc/...` reaches tRPC too.
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url ?? '';
    if (!(route === '/trpc' || route.startsWith('/trpc/')) || SAFE_METHODS.has(req.method)) return;
    const mediaType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json')
      return reply.status(415).send({ error: 'the board takes application/json only' });
  });

  registerMachineApi(app, root, config, changes, {
    pingMs: options.pingMs ?? 25_000,
    ...(options.vocabulary === undefined ? {} : { vocabulary: options.vocabulary }),
  });

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }) => ({ root, config, changes, username: req.username! }),
      onError: ({ error, path }) => {
        if (error.code === 'INTERNAL_SERVER_ERROR') app.log.error({ err: error, path }, 'tRPC error');
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  });

  return app;
}
