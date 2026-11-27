import type { ListedTask } from './trpc';

/** The browser preference that makes Todo list the cards delayed past today too; off unless it holds `on`. */
export const TODO_SHOW_ALL_PREFERENCE_KEY = 'agent-board.todoShowAll';

/** The start of the local day after the one `now` falls on, in ms. */
export function startOfTomorrow(now: number): number {
  const day = new Date(now);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
}

/** A Todo card that is delayed, or the pending card of a schedule, and starts on a later day than `now`'s. */
export const startsAfterToday = (task: Pick<ListedTask, 'notBefore'>, now: number): boolean =>
  task.notBefore !== null && new Date(task.notBefore).getTime() >= startOfTomorrow(now);

export function readTodoShowAll(): boolean {
  try {
    return localStorage.getItem(TODO_SHOW_ALL_PREFERENCE_KEY) === 'on';
  } catch {
    return false;
  }
}

export function writeTodoShowAll(on: boolean): void {
  try {
    if (on) localStorage.setItem(TODO_SHOW_ALL_PREFERENCE_KEY, 'on');
    else localStorage.removeItem(TODO_SHOW_ALL_PREFERENCE_KEY);
  } catch {
    // Storage is blocked; the choice lasts until the page reloads.
  }
}
