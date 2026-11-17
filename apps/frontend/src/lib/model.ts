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

/** Default and the aliases; a `current` model that is neither (a full name) is added, so a task keeps showing its own. */
export function modelOptions(current: string | null = null): ModelOption[] {
  const options = [
    { value: DEFAULT_MODEL, label: 'Default' },
    ...MODEL_ALIASES.map(({ value, label }) => ({ value, label })),
  ];
  return current === null || options.some(({ value }) => value === current)
    ? options
    : [...options, { value: current, label: current }];
}

/** The model a select value stands for, as `tasks.configure` takes it: null is claude's default. */
export const modelFromOption = (value: string): string | null => (value === DEFAULT_MODEL ? null : value);

/** The options of a select for a task that has no model of its own yet. */
export const MODEL_OPTIONS: ModelOption[] = modelOptions();
