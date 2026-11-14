import { describe, expect, it } from 'vitest';
import { droppedPriority } from './tasks';

describe('droppedPriority', () => {
  it('keeps its own when it fits between the neighbours', () => {
    expect(droppedPriority('high', 'urgent', 'normal')).toBe('high');
    expect(droppedPriority('normal', 'normal', undefined)).toBe('normal');
    expect(droppedPriority('low', undefined, undefined)).toBe('low');
  });
  it('takes the neighbour above, else below, when it does not', () => {
    expect(droppedPriority('urgent', 'normal', 'low')).toBe('normal');
    expect(droppedPriority('low', undefined, 'high')).toBe('high');
    expect(droppedPriority('urgent', 'high', 'normal')).toBe('high');
  });
});
