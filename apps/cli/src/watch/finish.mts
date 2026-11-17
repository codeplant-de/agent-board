// Ending a watch: whoever finishes it (the unit, the dispatcher's tick, `board unwatch`) claims it first, so one of them wins and
// the event is written once.
import type { Backend } from '@agent-board/shared';
import { errorText, fence } from '../output/text.mts';
import { WATCH_MARKER } from '../task-rules.mts';
import { sanitizeEventText } from './fence.mts';
import { newWatchId } from './store.mts';
import type { WatchDef, WatchEvent, WatchStore } from './store.mts';

export interface FinishDeps {
  store: WatchStore;
  backend: Pick<Backend, 'addNote'>;
  now: () => Date;
  log: (line: string) => void;
}

async function note(deps: FinishDeps, event: WatchEvent): Promise<void> {
  deps.log(`EVENT ${event.task} ${event.name} ${event.kind} at=${event.at}`);
  try {
    await deps.backend.addNote(event.task, `${WATCH_MARKER} "${event.name}" reported.\n\n${fence(event.text)}`);
  } catch (error) {
    deps.log(`WARN note for watch ${event.name} on ${event.task} failed: ${errorText(error)}`);
  }
}

/**
 * Reports an event of a watch that stays open (a stream's lines): writes it into the spool and leaves a note in the task's thread.
 * The caller made sure the watch is still its own (`store.update`).
 */
export async function reportEvent(deps: FinishDeps, def: WatchDef, text: string): Promise<WatchEvent> {
  const event: WatchEvent = {
    id: newWatchId(),
    task: def.task,
    name: def.name,
    at: deps.now().toISOString(),
    kind: 'event',
    text: sanitizeEventText(text),
  };
  deps.store.writeEvent(event);
  await note(deps, event);
  return event;
}

/**
 * Ends `def` with an event or a timeout: claims the watch, writes the event into the spool, and leaves a note in the task's thread.
 * Undefined when someone else finished or removed the watch first; then nothing was written. A note that fails is logged and not
 * retried: the event is in the spool either way.
 */
export async function finishWatch(
  deps: FinishDeps,
  def: WatchDef,
  report: { kind: WatchEvent['kind']; text: string },
): Promise<WatchEvent | undefined> {
  const claim = deps.store.claim(def.task, def.name, def.id);
  if (claim === undefined) return undefined;
  const event: WatchEvent = {
    id: newWatchId(),
    task: def.task,
    name: def.name,
    at: deps.now().toISOString(),
    kind: report.kind,
    text: sanitizeEventText(report.text),
  };
  try {
    deps.store.writeEvent(event);
  } finally {
    claim.done();
  }
  await note(deps, event);
  return event;
}
