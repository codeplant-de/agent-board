import { describe, expect, it } from 'vitest';
import { startsIn } from './startsIn';

describe('startsIn', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const at = (ms: number) => new Date(now + ms).toISOString();

  it('reads as the time left, rounded to the minute', () => {
    expect(startsIn(at(4 * 3_600_000), now)).toBe('Starts in 4h');
    expect(startsIn(at(90 * 60_000), now)).toBe('Starts in 1h 30m');
    expect(startsIn(at(5 * 60_000 + 20_000), now)).toBe('Starts in 5m');
    expect(startsIn(at(26 * 3_600_000), now)).toBe('Starts in 1d 2h');
    expect(startsIn(new Date(now + 3_600_000), now)).toBe('Starts in 1h');
  });

  it('says under a minute for the last seconds, and nothing once due or without a delay', () => {
    expect(startsIn(at(20_000), now)).toBe('Starts in under 1m');
    expect(startsIn(at(0), now)).toBeUndefined();
    expect(startsIn(at(-5_000), now)).toBeUndefined();
    expect(startsIn(null, now)).toBeUndefined();
  });
});
