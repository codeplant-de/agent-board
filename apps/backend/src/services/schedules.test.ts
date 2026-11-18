import { describe, expect, it } from 'vitest';
import { nextOccurrence, type Rule } from './schedules';

const at = (iso: string) => new Date(iso);
const grid = (overrides: Partial<Rule> = {}): Rule => ({
  everyMs: 3_600_000,
  cron: null,
  moreCrons: [],
  timezone: null,
  anchorAt: at('2027-01-01T10:00:00Z'),
  until: null,
  ...overrides,
});
const cron = (pattern: string, overrides: Partial<Rule> = {}): Rule => ({
  everyMs: null,
  cron: pattern,
  moreCrons: [],
  timezone: 'Europe/Berlin',
  anchorAt: at('2027-01-01T00:00:00Z'),
  until: null,
  ...overrides,
});

describe('nextOccurrence on an interval', () => {
  it('starts at the anchor and stays on its grid', () => {
    expect(nextOccurrence(grid(), at('2027-01-01T09:00:00Z'), true)).toEqual(at('2027-01-01T10:00:00Z'));
    expect(nextOccurrence(grid(), at('2027-01-01T10:30:00Z'), false)).toEqual(at('2027-01-01T11:00:00Z'));
  });

  it('includes the time itself only when inclusive', () => {
    expect(nextOccurrence(grid(), at('2027-01-01T11:00:00Z'), true)).toEqual(at('2027-01-01T11:00:00Z'));
    expect(nextOccurrence(grid(), at('2027-01-01T11:00:00Z'), false)).toEqual(at('2027-01-01T12:00:00Z'));
  });

  it('skips the runs missed during a long gap and keeps the grid', () => {
    expect(nextOccurrence(grid(), at('2027-01-05T03:20:00Z'), true)).toEqual(at('2027-01-05T04:00:00Z'));
  });

  it('ends after until, which itself is still a run', () => {
    const rule = grid({ until: at('2027-01-01T12:00:00Z') });
    expect(nextOccurrence(rule, at('2027-01-01T10:30:00Z'), false)).toEqual(at('2027-01-01T11:00:00Z'));
    expect(nextOccurrence(rule, at('2027-01-01T11:00:00Z'), false)).toEqual(at('2027-01-01T12:00:00Z'));
    expect(nextOccurrence(rule, at('2027-01-01T12:00:00Z'), false)).toBeNull();
  });
});

describe('nextOccurrence past the dates a Date holds', () => {
  it('is null instead of an invalid date', () => {
    // The first run, about 222,000 years out, is still a date; the second is past the 8.64e15 ms a Date holds.
    const rule = grid({ everyMs: 7e15 });
    const first = nextOccurrence(rule, at('2027-01-01T10:00:00Z'), false);
    expect(first?.getTime()).toBe(at('2027-01-01T10:00:00Z').getTime() + 7e15);
    expect(nextOccurrence(rule, first!, false)).toBeNull();
  });
});

describe('nextOccurrence on a cron expression', () => {
  it('matches in the time zone, at or after the time', () => {
    const rule = cron('0 9 * * 1-5');
    // Friday 2027-01-01 08:00Z is 09:00 in Berlin.
    expect(nextOccurrence(rule, at('2027-01-01T08:00:00Z'), true)).toEqual(at('2027-01-01T08:00:00Z'));
    expect(nextOccurrence(rule, at('2027-01-01T08:00:00Z'), false)).toEqual(at('2027-01-04T08:00:00Z'));
    expect(nextOccurrence(rule, at('2027-01-01T08:00:01Z'), true)).toEqual(at('2027-01-04T08:00:00Z'));
  });

  it('keeps the local time across the change to summer time', () => {
    const rule = cron('0 9 * * *');
    // Berlin moves to summer time on 2027-03-28: 09:00 is 08:00Z before and 07:00Z after.
    expect(nextOccurrence(rule, at('2027-03-27T08:00:00Z'), false)).toEqual(at('2027-03-28T07:00:00Z'));
    expect(nextOccurrence(rule, at('2027-10-30T07:00:00Z'), false)).toEqual(at('2027-10-31T08:00:00Z'));
  });

  it('ends after until', () => {
    const rule = cron('0 9 * * *', { until: at('2027-01-02T08:00:00Z') });
    expect(nextOccurrence(rule, at('2027-01-01T08:00:00Z'), false)).toEqual(at('2027-01-02T08:00:00Z'));
    expect(nextOccurrence(rule, at('2027-01-02T08:00:00Z'), false)).toBeNull();
  });
});

describe('nextOccurrence on several cron expressions', () => {
  const first = cron('0 9 * * 5#1', { timezone: 'UTC', moreCrons: ['0 9 * * 5#3'] });

  it('takes the earliest next match over all of them', () => {
    expect(nextOccurrence(first, at('2027-01-01T00:00:00Z'), true)).toEqual(at('2027-01-01T09:00:00Z'));
    expect(nextOccurrence(first, at('2027-01-01T09:00:00Z'), false)).toEqual(at('2027-01-15T09:00:00Z'));
    expect(nextOccurrence(first, at('2027-01-15T09:00:00Z'), false)).toEqual(at('2027-02-05T09:00:00Z'));
  });

  it('reads every expression in the one time zone', () => {
    const berlin = cron('0 9 * * *', { moreCrons: ['0 18 * * *'] });
    expect(nextOccurrence(berlin, at('2027-01-01T08:00:00Z'), false)).toEqual(at('2027-01-01T17:00:00Z'));
    expect(nextOccurrence(berlin, at('2027-01-01T17:00:00Z'), false)).toEqual(at('2027-01-02T08:00:00Z'));
  });

  it('is inclusive and bounded by until like one expression', () => {
    expect(nextOccurrence(first, at('2027-01-15T09:00:00Z'), true)).toEqual(at('2027-01-15T09:00:00Z'));
    expect(
      nextOccurrence({ ...first, until: at('2027-01-10T00:00:00Z') }, at('2027-01-01T09:00:00Z'), false),
    ).toBeNull();
  });
});
