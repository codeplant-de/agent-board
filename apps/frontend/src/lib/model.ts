import { MODEL_ALIASES } from '@agent-board/shared';

/** The select value that stands for no model: claude's default. */
export const DEFAULT_MODEL = 'default';

export interface ModelOption {
  value: string;
  label: string;
}

/** The name the board shows for a model: an alias by its label, anything else as it is. */
export function modelLabel(model: string): string {
  return MODEL_ALIASES.find((alias) => alias.value === model)?.label ?? model;
}

const ALIAS_OPTIONS: ModelOption[] = MODEL_ALIASES.map(({ value, label }) => ({ value, label }));

/**
 * Default and `offered` (the aliases unless a machine's catalogue gave its models). A `current` model that `offered` lacks
 * is added after Default, labelled from `known` when it is there, so a task keeps showing its own.
 */
export function modelOptions(
  current: string | null,
  {
    offered = ALIAS_OPTIONS,
    known = offered,
  }: { offered?: readonly ModelOption[]; known?: readonly ModelOption[] } = {},
): ModelOption[] {
  const missing =
    current === null || current === DEFAULT_MODEL || offered.some(({ value }) => value === current)
      ? []
      : [{ value: current, label: known.find(({ value }) => value === current)?.label ?? modelLabel(current) }];
  return [
    { value: DEFAULT_MODEL, label: 'Default' },
    ...missing,
    ...offered.map(({ value, label }) => ({ value, label })),
  ];
}

/** The model a select value stands for, as `tasks.configure` takes it: null is claude's default. */
export const modelFromOption = (value: string): string | null => (value === DEFAULT_MODEL ? null : value);
