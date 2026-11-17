import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, modelFromOption, modelOptions } from './model';

const ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];
const values = (options: { value: string }[]): string[] => options.map(({ value }) => value);

describe('modelOptions', () => {
  it('offers Default and the four aliases', () => {
    expect(values(modelOptions(null))).toEqual([DEFAULT_MODEL, ...ALIASES]);
    expect(modelOptions('opus')).toEqual(modelOptions(null));
    expect(modelOptions(DEFAULT_MODEL)).toEqual(modelOptions(null));
  });

  it('adds a full name that is not offered after Default, so the task keeps showing it', () => {
    expect(values(modelOptions('claude-opus-5-5'))).toEqual([DEFAULT_MODEL, 'claude-opus-5-5', ...ALIASES]);
    expect(modelOptions('claude-opus-5-5')[1]).toEqual({ value: 'claude-opus-5-5', label: 'claude-opus-5-5' });
  });

  it('offers a machine’s models instead of the aliases, and names a current one from the known models', () => {
    const offered = [{ value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }];
    expect(modelOptions('claude-sonnet-5-5', { offered })).toEqual([
      { value: DEFAULT_MODEL, label: 'Default' },
      ...offered,
    ]);
    expect(
      modelOptions('claude-opus-5-5', { offered, known: [{ value: 'claude-opus-5-5', label: 'Opus 5.5' }] }),
    ).toEqual([
      { value: DEFAULT_MODEL, label: 'Default' },
      { value: 'claude-opus-5-5', label: 'Opus 5.5' },
      ...offered,
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
