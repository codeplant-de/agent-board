// The user pressed Stop on a watch on the board. The dispatcher's tick (the listener ticks when the board says a task changed)
// ends that watch here: the agent hears of it like any event, so a parked task whose last watch it was wakes the usual way.
import type { Backend } from '@agent-board/shared';
import { errorText } from '../output/text.mts';
import { finishWatch } from './finish.mts';
import type { FinishDeps } from './finish.mts';
import { publishWatches } from './publish.mts';

export interface StopDeps extends FinishDeps {
  backend: Pick<Backend, 'addNote' | 'setWatches' | 'ackWatchStops'>;
  // Print what would be done and change nothing.
  dryRun?: boolean;
}

/**
 * Ends the watches of `task` whose ids the board lists as stopped by the user: each is claimed (no event from its source) and
 * reports that it was stopped. Every id is acknowledged, also one without a local watch (already finished, or on no machine's
 * store any more), so a stop cannot come back on the next tick. The board's list follows. Never throws.
 */
export async function handleWatchStops(deps: StopDeps, task: { id: string; watchStops: string[] }): Promise<void> {
  const { id, watchStops } = task;
  if (watchStops.length === 0) return;
  try {
    const open = deps.store.list(id).defs;
    for (const watchId of watchStops) {
      const def = open.find((candidate) => candidate.id === watchId);
      if (def === undefined) {
        deps.log(`STOP-WATCH ${id} ${watchId} no such watch`);
        continue;
      }
      deps.log(`${deps.dryRun === true ? 'DRY ' : ''}STOP-WATCH ${id} ${def.name}`);
      if (deps.dryRun === true) continue;
      await finishWatch(deps, def, { kind: 'stopped', text: `Watch "${def.name}" was stopped by you.` });
    }
    if (deps.dryRun === true) return;
    await deps.backend.ackWatchStops(id, watchStops);
    await publishWatches(deps, id);
  } catch (error) {
    deps.log(`WARN stopping watches of ${id} failed: ${errorText(error)}`);
  }
}
