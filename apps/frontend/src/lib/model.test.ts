import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, MODEL_OPTIONS, modelFromOption, modelOptions } from './model';

describe('modelOptions', () => {
  it('offers Default and the four aliases', () => {
    expect(MODEL_OPTIONS.map(({ value }) => value)).toEqual([DEFAULT_MODEL, 'fable', 'opus', 'sonnet', 'haiku']);
    expect(modelOptions('opus')).toEqual(MODEL_OPTIONS);
    expect(modelOptions(null)).toEqual(MODEL_OPTIONS);
  });

  it('adds a full name that is not an alias, so the task keeps showing it', () => {
    expect(modelOptions('claude-opus-5-5')).toEqual([
      ...MODEL_OPTIONS,
      { value: 'claude-opus-5-5', label: 'claude-opus-5-5' },
    ]);
  });
});

describe('modelFromOption', () => {
  it('turns Default into claude’s default and keeps anything else', () => {
    expect(modelFromOption(DEFAULT_MODEL)).toBeNull();
    expect(modelFromOption('opus')).toBe('opus');
    expect(modelFromOption('claude-opus-5-5')).toBe('claude-opus-5-5');
  });
});
