import { describe, expect, it } from 'vitest';
import { DEFAULT_EFFORT, EFFORT_OPTIONS, effortFromOption } from './effort';

describe('EFFORT_OPTIONS', () => {
  it('offers Default and the five levels, with xhigh shown as Extra high', () => {
    expect(EFFORT_OPTIONS).toEqual([
      { value: DEFAULT_EFFORT, label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' },
    ]);
  });
});

describe('effortFromOption', () => {
  it('maps Default to null and a level to itself', () => {
    expect(effortFromOption(DEFAULT_EFFORT)).toBeNull();
    expect(effortFromOption('xhigh')).toBe('xhigh');
  });
});
