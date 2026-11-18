import { describe, expect, it } from 'vitest';
import { DEFAULT_LANE, laneFromOption, laneOptions } from './lane';

describe('laneOptions', () => {
  it('puts the default lane first and then the lanes offered', () => {
    expect(laneOptions(null, ['general', 'reviews'])).toEqual([
      { value: DEFAULT_LANE, label: 'Default lane' },
      { value: 'general', label: 'general' },
      { value: 'reviews', label: 'reviews' },
    ]);
  });

  it('keeps the lane a task asks for when no machine offers it, once', () => {
    expect(laneOptions('docs', ['general']).map(({ value }) => value)).toEqual([DEFAULT_LANE, 'docs', 'general']);
    expect(laneOptions('general', ['general']).map(({ value }) => value)).toEqual([DEFAULT_LANE, 'general']);
  });

  it('reads the default lane back as null, and a name as itself; no name can look like the default', () => {
    expect(laneFromOption(DEFAULT_LANE)).toBeNull();
    expect(laneFromOption('reviews')).toBe('reviews');
  });
});
