import { describe, expect, it } from 'vitest';
import { parseRepeatRule } from './repeat';

describe('parseRepeatRule', () => {
  it('reads a duration as an interval in ms', () => {
    expect(parseRepeatRule('2h', 'Europe/Berlin')).toEqual({ every: 7_200_000 });
    expect(parseRepeatRule(' 1d 2h ', 'UTC')).toEqual({ every: 93_600_000 });
  });

  it('reads five fields as a cron expression in the given time zone', () => {
    expect(parseRepeatRule('0 9 * * 1-5', 'Europe/Berlin')).toEqual({ cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' });
  });

  it('explains what it cannot read', () => {
    for (const bad of ['', 'often', '0 9 * *', '0 0 9 * * *', '0m'])
      expect(parseRepeatRule(bad, 'UTC'), bad).toHaveProperty('error');
  });
});
