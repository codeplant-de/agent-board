import { describe, expect, it } from 'vitest';
import { canTakeBack, liveness } from './liveness';

describe('liveness', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('reads as active, then quiet in amber, then red', () => {
    expect(liveness(null, now)).toEqual({ text: 'starting', color: 'dimmed' });
    expect(liveness(ago(40_000), now)).toEqual({ text: 'active 40s ago', color: 'dimmed' });
    expect(liveness(ago(3 * 60_000 + 7_000), now)).toEqual({ text: 'active 3m 7s ago', color: 'dimmed' });
    expect(liveness(ago(6 * 60_000), now)).toEqual({ text: 'quiet for 6 min', color: 'yellow' });
    expect(liveness(ago(12 * 60_000), now)).toEqual({ text: 'quiet for 12 min', color: 'red' });
  });

  it('lets a task be taken back only after 20 quiet minutes, well after the text turns red', () => {
    expect(canTakeBack(null, now)).toBe(false);
    expect(canTakeBack(ago(12 * 60_000), now)).toBe(false);
    expect(canTakeBack(ago(19 * 60_000 + 59_000), now)).toBe(false);
    expect(canTakeBack(ago(20 * 60_000), now)).toBe(true);
  });
});
