// What the board shows of a task's watches: a list of names, what each looks at and its state, and how many events wait for the agent. It is built
// from the local store and never holds a command or its output. Publishing is best effort and never throws into its caller.
import { isWatchId, MAX_TASK_WATCHES, MAX_WATCH_LABEL_CHARS, MAX_WATCH_STATUS_CHARS } from '@agent-board/shared';
import type { Backend, TaskWatch } from '@agent-board/shared';
import { BackendError } from '../backend/backend.mts';
import { errorText, oneLine } from '../output/text.mts';
import { clockTime, describeEvery, withoutControls } from './fence.mts';
import type { WatchDef, WatchStore } from './store.mts';

export interface PublishDeps {
  store: WatchStore;
  backend: Pick<Backend, 'setWatches'>;
  now: () => Date;
  log: (line: string) => void;
}

/** The unit publishes a task's changing state at most this often; an event or a finished watch goes at once. */
export const PUBLISH_EVERY_MS = 15_000;

/** An unchanged state is published again after this long, so the board's time of the last look does not freeze. */
export const REFRESH_MS = 5 * 60_000;

const COMMAND_RESULT = /^(exit \d+|too slow, stopped|killed)/;

function labelOf(def: WatchDef): string {
  const { source } = def;
  if (source.kind === 'timer') return 'timer';
  if (source.kind === 'command') return `command, every ${describeEvery(def.everyMs)}`;
  const number = source.pr.slice(source.pr.lastIndexOf('/') + 1);
  if (source.kind === 'pr') return `merge of #${number}`;
  return `CI #${number}${source.required ? ' · required' : ''}`;
}

function statusOf(def: WatchDef, now: Date): string {
  const { source, last } = def;
  if (source.kind === 'timer') return `fires at ${clockTime(new Date(def.deadline), now)}`;
  if (last === undefined) return source.kind === 'command' ? 'not run yet' : 'not looked at yet';
  if (source.kind === 'ci' || source.kind === 'pr')
    return withoutControls(oneLine(last.summary, MAX_WATCH_STATUS_CHARS));
  const result = COMMAND_RESULT.exec(last.summary)?.[1] ?? 'ran';
  return `${result} at ${clockTime(new Date(last.at), now)}`;
}

/** The watches of `task` as the board shows them, in name order; the command text and what it printed are left out. */
export function taskWatchesOf(store: WatchStore, task: string, now: Date): TaskWatch[] {
  return store
    .list(task)
    .defs.filter((def) => isWatchId(def.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_TASK_WATCHES)
    .map((def) => ({
      id: def.id,
      name: def.name,
      kind: def.source.kind,
      label: labelOf(def).slice(0, MAX_WATCH_LABEL_CHARS),
      status: statusOf(def, now),
      deadline: def.deadline,
      ...(def.last === undefined || def.source.kind === 'timer' ? {} : { lastAttemptAt: def.last.at }),
    }));
}

let warnedUnsupported = false;

/**
 * Tells the board the task's watches as the store holds them now (none: clears the list). A board without `task.watches` is left
 * alone, with one line per process; any other failure is logged and the next publish tries again.
 */
export async function publishWatches(deps: PublishDeps, task: string): Promise<void> {
  try {
    const watches = taskWatchesOf(deps.store, task, deps.now());
    await deps.backend.setWatches(task, watches.length === 0 ? null : watches, deps.store.events(task).length);
  } catch (error) {
    if (error instanceof BackendError && error.missingFeature === 'task.watches') {
      if (!warnedUnsupported) deps.log('the board server does not show watches yet; they are not published');
      warnedUnsupported = true;
      return;
    }
    deps.log(`WARN publishing the watches of ${task} failed: ${errorText(error)}`);
  }
}
