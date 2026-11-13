import { initTRPC, TRPCError } from '@trpc/server';
import { ZodError } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { AppError } from '../services/errors';

export interface Context {
  db: Db;
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

export const procedure = t.procedure.use(mapErrors);
