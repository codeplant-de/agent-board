import { ContractError, MAX_SCHEDULE_CRONS, parseDuration } from '@agent-board/shared';

export type RepeatRule = { every: number } | { cron: string; moreCrons?: string[]; timezone: string };

/** The interval `line` names (`2h`), or undefined when it is not a duration. */
function readInterval(line: string): number | undefined {
  try {
    return parseDuration(line);
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return undefined;
  }
}

/** Whether `line` is a duration such as `2h`, which stands alone as the rule, rather than a cron expression. */
export function isInterval(line: string): boolean {
  return readInterval(line.trim()) !== undefined;
}

const normalized = (expression: string): string => expression.split(/\s+/).join(' ');

/**
 * What the form's rule field holds: a duration (`2h`), or 5-field cron expressions, one per line, read in `timezone`. The first
 * expression is `cron`, the others `moreCrons`.
 */
export function parseRepeatRule(text: string, timezone: string): RepeatRule | { error: string } {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const [rule, ...others] = lines;
  if (rule === undefined) return { error: 'Give an interval such as 2h, or a cron expression such as 0 9 * * 1-5' };
  const every = others.length === 0 ? readInterval(rule) : undefined;
  if (every !== undefined) return { every };
  const bad = lines.find((line) => line.split(/\s+/).length !== 5);
  if (bad !== undefined)
    return {
      error:
        others.length === 0
          ? 'Use an interval such as 2h or 1d, or a cron expression with 5 fields'
          : `"${bad.slice(0, 40)}" does not have 5 cron fields; give one expression per line`,
    };
  if (lines.length > MAX_SCHEDULE_CRONS) return { error: `At most ${MAX_SCHEDULE_CRONS} cron expressions` };
  const same = lines.map(normalized);
  if (same.some((line, index) => same.indexOf(line) !== index)) return { error: 'A cron expression is given twice' };
  return { cron: rule, ...(others.length > 0 ? { moreCrons: others } : {}), timezone };
}
