import { ContractError, parseSealed, type Field } from '@agent-board/shared';
import { z } from 'zod';

/** Runs a shared parser as a zod check, so a bad value is a BAD_REQUEST with the parser's reason. */
export const parsedBy = <S extends z.ZodType, T>(source: S, parse: (value: z.output<S>) => T) =>
  source.transform((value, ctx) => {
    try {
      return parse(value);
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      ctx.addIssue({ code: 'custom', message: error.message });
      return z.NEVER;
    }
  });

/** A sealed value (an envelope within the field's size limit): the server checks nothing else about it. */
export const sealed = (field: Field, what: string) => parsedBy(z.string(), (value) => parseSealed(value, field, what));
