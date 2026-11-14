import { ContractError, parseDuration } from '@agent-board/shared';

export type RepeatRule = { every: number } | { cron: string; timezone: string };

/** What the form's rule field holds: a duration (`2h`) or a 5-field cron expression, read in `timezone`. */
export function parseRepeatRule(text: string, timezone: string): RepeatRule | { error: string } {
  const rule = text.trim();
  if (rule === '') return { error: 'Give an interval such as 2h, or a cron expression such as 0 9 * * 1-5' };
  try {
    return { every: parseDuration(rule) };
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
  }
  if (rule.split(/\s+/).length !== 5)
    return { error: 'Use an interval such as 2h or 1d, or a cron expression with 5 fields' };
  return { cron: rule, timezone };
}
