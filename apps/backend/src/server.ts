import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import Fastify, { type FastifyRequest } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/client';
import { registerIntakeApi } from './intake-api';
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
    // A transcript batch can carry a few large tool results.
    bodyLimit: 16 * 1024 * 1024,
    trustProxy: true,
  });

  app.decorateRequest('username', null);
  app.addHook('onClose', async () => changes.close());
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(STATUS[err.code]).send({ error: err.message });
    app.log.error(err);
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: status === 500 ? 'internal error' : (err as Error).message });
  });

  app.get('/healthz', async () => ({ ok: true }));

  // The machine and intake APIs have their own tokens and are routed past the login; everything else needs a signed-in user.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz' || req.url.startsWith('/api/machine/') || req.url.startsWith('/api/intake/')) return;
    req.username = userFrom(req, config);
    if (!req.username) return reply.status(403).send({ error: 'not allowed on this board' });
  });

  registerMachineApi(app, root, config, changes, {
    pingMs: options.pingMs ?? 25_000,
    ...(options.vocabulary === undefined ? {} : { vocabulary: options.vocabulary }),
  });
  if (config.intake) registerIntakeApi(app, root, config.intake);

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
