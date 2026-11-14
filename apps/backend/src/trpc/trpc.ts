import { initTRPC, TRPCError } from '@trpc/server';
import { ZodError } from 'zod';
import type { Config } from '../config';
import type { Db, Tx } from '../db/client';
import { withOwner } from '../db/scope';
import { AppError } from '../services/errors';

export interface Context {
  /** The pool handle; procedures use `ctx.db`, the request's transaction. */
  root: Db;
  config: Config;
  username: string;
}

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: { ...shape.data, zodIssues: error.cause instanceof ZodError ? error.cause.issues : null },
    };
  },
});

export const router = t.router;

const mapErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof AppError) {
    const cause = result.error.cause;
    throw new TRPCError({ code: cause.code, message: cause.message, cause });
  }
  return result;
});

/** Carries a failed procedure's result out of the transaction, which only rolls back on a throw. */
class Rollback<R> extends Error {
  constructor(readonly result: R) {
    super('procedure failed');
  }
}

/** Runs the rest of the procedure in one transaction scoped to the user, exposed as `ctx.db`. */
const scoped = t.middleware(async ({ ctx, next }) => {
  const run = (db: Tx) => next({ ctx: { db, root: undefined } });
  try {
    return await withOwner(ctx.root, ctx.username, async (db) => {
      const result = await run(db);
      if (!result.ok) throw new Rollback(result);
      return result;
    });
  } catch (error) {
    if (error instanceof Rollback) return error.result as Awaited<ReturnType<typeof run>>;
    throw error;
  }
});

export const procedure = t.procedure.use(mapErrors).use(scoped);
