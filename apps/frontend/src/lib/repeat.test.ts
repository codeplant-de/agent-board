import { describe, expect, it } from 'vitest';
import { isInterval, parseRepeatRule } from './repeat';

describe('parseRepeatRule', () => {
  it('reads a duration as an interval in ms', () => {
    expect(parseRepeatRule('2h', 'Europe/Berlin')).toEqual({ every: 7_200_000 });
    expect(parseRepeatRule(' 1d 2h ', 'UTC')).toEqual({ every: 93_600_000 });
  });

  it('reads five fields as a cron expression in the given time zone', () => {
    expect(parseRepeatRule('0 9 * * 1-5', 'Europe/Berlin')).toEqual({ cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' });
  });

  it('reads one cron expression per line as the first and the others', () => {
    expect(parseRepeatRule('0 9 * * 5#1\n  0 9 * * 5#3 \n\n', 'UTC')).toEqual({
      cron: '0 9 * * 5#1',
      moreCrons: ['0 9 * * 5#3'],
      timezone: 'UTC',
    });
  });

  it('refuses a repeated expression, an interval among them, a line that is not cron, and more than ten', () => {
    expect(parseRepeatRule('0 9 * * *\n0  9 * * *', 'UTC')).toEqual({ error: 'A cron expression is given twice' });
    expect(parseRepeatRule('0 9 * * *\n2h', 'UTC')).toHaveProperty('error');
    expect(parseRepeatRule('0 9 * * *\n0 9 * *', 'UTC')).toHaveProperty('error');
    const eleven = Array.from({ length: 11 }, (_, hour) => `0 ${hour} * * *`).join('\n');
    expect(parseRepeatRule(eleven, 'UTC')).toHaveProperty('error');
    expect(parseRepeatRule(eleven.split('\n').slice(0, 10).join('\n'), 'UTC')).toHaveProperty('cron');
  });

  it('explains what it cannot read', () => {
    for (const bad of ['', 'often', '0 9 * *', '0 0 9 * * *', '0m'])
      expect(parseRepeatRule(bad, 'UTC'), bad).toHaveProperty('error');
  });
});

describe('isInterval', () => {
  it('tells a duration from a cron expression', () => {
    expect(isInterval(' 2h ')).toBe(true);
    expect(isInterval('0 9 * * 1-5')).toBe(false);
    expect(isInterval('')).toBe(false);
  });
});
