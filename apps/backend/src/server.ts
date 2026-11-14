import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import Fastify, { type FastifyRequest } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/client';
import { registerMachineApi } from './machine-api';
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

/**
 * Who is using the UI. In production Traefik's Authelia forward-auth sets the Remote-* headers (and strips any
 * a client sends); locally DEV_AUTH_USER stands in. Null when the user is not in an allowed group.
 */
export function userFrom(req: FastifyRequest, config: Config): string | null {
  if (config.devAuthUser) return config.devAuthUser.toLowerCase();
  const username = header(req, 'remote-user');
  if (!username) return null;
  const groups = (header(req, 'remote-groups') ?? '').split(',').map((g) => g.trim());
  return groups.some((group) => config.allowedGroups.includes(group)) ? username.toLowerCase() : null;
}

const STATUS: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

export async function buildServer(config: Config, root: Db) {
  const app = Fastify({
    logger: config.nodeEnv === 'test' ? false : { level: 'info' },
    // A transcript batch can carry a few large tool results.
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: true,
  });

  app.decorateRequest('username', null);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(STATUS[err.code]).send({ error: err.message });
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: status === 500 ? 'internal error' : (err as Error).message });
  });

  app.get('/healthz', async () => ({ ok: true }));

  // The machine API has its own tokens and is routed past the login; everything else needs a signed-in user.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz' || req.url.startsWith('/api/machine/')) return;
    req.username = userFrom(req, config);
    if (!req.username) return reply.status(403).send({ error: 'not allowed on this board' });
  });

  registerMachineApi(app, root, config);

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: ({ req }) => ({ root, config, username: req.username! }),
      onError: ({ error, path }) => {
        if (error.code === 'INTERNAL_SERVER_ERROR') app.log.error({ err: error, path }, 'tRPC error');
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  });

  return app;
}
