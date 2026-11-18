/** The select value that stands for no lane: the default lane of whichever machine takes the task. A name can never look like it. */
export const DEFAULT_LANE = '(default)';

export interface LaneOption {
  value: string;
  label: string;
}

/**
 * The default lane and the `offered` names. A `current` lane that `offered` lacks is added after the default, so a task keeps
 * showing its own.
 */
export function laneOptions(current: string | null, offered: readonly string[]): LaneOption[] {
  const names =
    current === null || current === DEFAULT_LANE || offered.includes(current) ? offered : [current, ...offered];
  return [{ value: DEFAULT_LANE, label: 'Default lane' }, ...names.map((name) => ({ value: name, label: name }))];
}

/** The lane a select value stands for, as `tasks.configure` takes it: null is the default lane. */
export const laneFromOption = (value: string): string | null => (value === DEFAULT_LANE ? null : value);
