// The one line a person at a terminal gets when the board knows of a newer CLI than the one they run.
import { updateCliHint } from '../backend/backend.mts';
import { compareVersions } from '@agent-board/shared';
import type { UpdateState } from './update-state.mts';

export const HINT_EVERY_MS = 24 * 60 * 60 * 1000;

export interface HintInput {
  // The newest release the board advertised; undefined when it named none.
  advertised: string | undefined;
  // This CLI's version; a checkout's `x.y.z-dev` compares as x.y.z.
  version: string;
  state: UpdateState;
  now: Date;
  // Only a person at a terminal: stderr is a TTY and the command does not run inside a board run.
  interactive: boolean;
}

// The line to show, or undefined; the caller marks it shown once it printed, so it is shown at most once per 24 hours.
export function updateHint({ advertised, version, state, now, interactive }: HintInput): string | undefined {
  if (!interactive || advertised === undefined || compareVersions(advertised, version) <= 0) return undefined;
  const last = state.hintShownAt();
  if (last !== undefined && now.getTime() - last.getTime() < HINT_EVERY_MS) return undefined;
  return `board ${advertised} is available (this is ${version}); ${updateCliHint()}`;
}
