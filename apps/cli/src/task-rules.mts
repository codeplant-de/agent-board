import { promptSkill, shortSkill } from '@agent-board/shared';
import type { Task, UnreadableField } from '@agent-board/shared';
import type { Lane } from './config/config.mts';

export const START_MARKER = 'agent-board: started';
// The start of the note that ends a wait; the rest of it is why, and the resumed agent is told.
export const WAKE_MARKER = 'agent-board: wait over:';

// The lane of this machine whose own work the task is: the lane naming the skill its prompt starts with, else the lane
// with "*". Undefined when no lane owns it; any lane may still borrow it.
export function ownLane(task: Task, lanes: Lane[]): string | undefined {
  const skill = promptSkill(task.input);
  const short = skill === undefined ? undefined : shortSkill(skill);
  return (
    lanes.find((lane) => short !== undefined && lane.skills.includes(short)) ??
    lanes.find((lane) => lane.skills.includes('*'))
  )?.name;
}

// The fields this machine could not open that a run needs: its prompt and the directory it works in. A task listed here must
// not be started, since an empty prompt or a missing directory would run something else than the user wrote.
export function unreadableForRun(task: Task): UnreadableField[] {
  return task.unreadable.filter((field) => field !== 'title');
}

/**
 * Why this task is never run, whatever the board says, or undefined. An agent's proposal is the user's to start: starting it seals
 * its prompt again as the user's (creator "user"), so a task that still names the agent as its creator was not started by the
 * user, and its prompt must never get the user's permissions.
 */
export function neverRun(task: Task): string | undefined {
  return task.createdBy === 'agent'
    ? 'An agent proposed this task and you have not started it: a worker only runs what you started or your own machines created.'
    : undefined;
}
