import { MODEL_ALIASES } from '@agent-board/shared';

/** The name the board shows for a model: an alias by its label, anything else as it is. */
export function modelLabel(model: string): string {
  return MODEL_ALIASES.find((alias) => alias.value === model)?.label ?? model;
}
