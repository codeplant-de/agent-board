import { describe, expect, it } from 'vitest';
import { liveness } from './liveness';

describe('liveness', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('reads as active, then quiet in amber, then red', () => {
    expect(liveness(null, now)).toEqual({ text: 'starting', color: 'dimmed' });
    expect(liveness(ago(40_000), now)).toEqual({ text: 'active 40s ago', color: 'dimmed' });
    expect(liveness(ago(3 * 60_000), now)).toEqual({ text: 'active 3 min ago', color: 'dimmed' });
    expect(liveness(ago(6 * 60_000), now)).toEqual({ text: 'quiet for 6 min', color: 'yellow' });
    expect(liveness(ago(12 * 60_000), now)).toEqual({ text: 'quiet for 12 min', color: 'red' });
  });
});
