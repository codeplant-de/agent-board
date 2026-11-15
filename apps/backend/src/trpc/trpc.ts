import { initTRPC, TRPCError } from '@trpc/server';
import { ZodError } from 'zod';
import type { Config } from '../config';
import type { Db, Tx } from '../db/client';
import { appUsers } from '../db/schema';
import { withOwner } from '../db/scope';
import type { Changes } from '../services/changes';
import { AppError } from '../services/errors';

export interface Context {
  /** The pool handle; procedures use `ctx.db`, the request's transaction. */
  root: Db;
  config: Config;
  changes: Changes;
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
    throw new TRPCError({
      code: cause.code === 'UNPROCESSABLE' ? 'UNPROCESSABLE_CONTENT' : cause.code,
      message: cause.message,
      cause,
    });
  }
  return result;
});

/** Carries a failed procedure's result out of the transaction, which only rolls back on a throw. */
class Rollback<R> extends Error {
  constructor(readonly result: R) {
    super('procedure failed');
  }
}

/** Keys and machines do not change what dispatch decides. */
const changesDispatch = (path: string): boolean => path.startsWith('tasks.') || path.startsWith('schedules.');

/** Runs the rest of the procedure in one transaction scoped to the user, exposed as `ctx.db`. */
const scoped = t.middleware(async ({ ctx, next, path, type }) => {
  const run = (db: Tx) => next({ ctx: { db, root: undefined } });
  try {
    const result = await withOwner(ctx.root, ctx.username, async (db) => {
      // Every board belongs to a row in app_user; the first request of a user creates it.
      await db.insert(appUsers).values({ username: ctx.username }).onConflictDoNothing();
      const result = await run(db);
      if (!result.ok) throw new Rollback(result);
      return result;
    });
    if (type === 'mutation' && changesDispatch(path)) ctx.changes.notify(ctx.username);
    return result;
  } catch (error) {
    if (error instanceof Rollback) return error.result as Awaited<ReturnType<typeof run>>;
    throw error;
  }
});

export const procedure = t.procedure.use(mapErrors).use(scoped);
