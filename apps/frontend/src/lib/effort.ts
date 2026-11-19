import { EFFORTS, type Effort } from '@agent-board/shared';

/** The select value that stands for no effort level: claude's default. */
export const DEFAULT_EFFORT = 'default';

/** The name the board shows for an effort level. */
export const EFFORT_LABEL: Record<Effort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export const EFFORT_OPTIONS: { value: string; label: string }[] = [
  { value: DEFAULT_EFFORT, label: 'Default' },
  ...EFFORTS.map((value) => ({ value, label: EFFORT_LABEL[value] })),
];

/** The effort a select value stands for, as `tasks.configure` takes it: null is claude's default. */
export const effortFromOption = (value: string): Effort | null => EFFORTS.find((effort) => effort === value) ?? null;
