/**
 * One dispatcher tick: sweep stale Running tasks, wake waiting tasks whose time is up, fill free slots from the top of Todo,
 * then run the checks of waiting tasks that are due.
 * No LLM calls. Add --dry-run to read everything and print every write and process start instead.
 */
import { BackendError, isVocabularyRefusal, updateCliHint } from './backend.mts';
import { buildContext, print, skipTickWhileServerOlder } from './cli.mts';
import type { Context } from './cli.mts';
import type { Task } from '@agent-board/shared';
import { promptSkill } from '@agent-board/shared';
import {
  checkOutputBlock,
  decideStale,
  decideWake,
  neverRun,
  notServableHere,
  ownLane,
  planPauses,
  planStarts,
  START_MARKER,
  unitName,
  unreadableForRun,
  WAKE_MARKER,
} from './decide.mts';
import type { LaneRun } from './decide.mts';
import { createRunFiles } from './runtime.mts';
import type { RunFiles } from './runtime.mts';
import { createSystem } from './system.mts';
import type { System } from './system.mts';
import { readLogTail } from './logs.mts';
import { fence } from './text.mts';
import type { CheckResult, WaitCheck, WaitStore } from './waits.mts';
import { CHECK_TIME_LIMIT_MS, createWaitStore, runCheck } from './waits.mts';

export interface DispatchDeps extends Context {
  system: System;
  files: RunFiles;
  now: () => Date;
  logTail: (taskId: string) => string;
  waits: WaitStore;
  runCheck: (check: WaitCheck) => Promise<CheckResult>;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Ends a wait on the board: the woken task, or undefined when it no longer waited or the call failed.
async function wakeTask(deps: DispatchDeps, task: Task, why: string): Promise<Task | undefined> {
  deps.print(`WAKE ${task.id} ${why.split('\n')[0]}`);
  try {
    const { applied, task: after } = await deps.backend.wake(task.id, `${WAKE_MARKER} ${why}`);
    if (!deps.dryRun) deps.waits.remove(task.id);
    return applied ? after : undefined;
  } catch (error) {
    deps.print(`WARN wake ${task.id} failed: ${errorText(error)}`);
    return undefined;
  }
}

// A check's task that the list does not show may be hidden from this CLI (a value it does not know) rather than gone: only
// the board's 404, or a task that no longer waits or runs here, lets the check go; anything else keeps it.
async function isGone(deps: DispatchDeps, id: string): Promise<boolean> {
  try {
    const task = await deps.backend.getTask(id);
    return !((task.status === 'waiting' || task.status === 'running') && task.machine === deps.config.machine);
  } catch (error) {
    if (error instanceof BackendError && error.fromApi && error.status === 404) return true;
    deps.print(
      isVocabularyRefusal(error)
        ? `KEEP-CHECK ${id} its task uses a value this CLI does not know; ${updateCliHint()}`
        : `KEEP-CHECK ${id} its task could not be read: ${errorText(error)}`,
    );
    return false;
  }
}

/**
 * Waits whose time is up, or whose check is gone, end now, before the slots are filled: the woken tasks are Todo again and can
 * start in this tick. Returns the tasks with the woken ones replaced, and the waiting tasks whose check is due.
 */
async function wakeDue(deps: DispatchDeps, tasks: Task[]): Promise<{ tasks: Task[]; checks: Task[] }> {
  const { config, waits } = deps;
  const waiting = tasks.filter((task) => task.status === 'waiting' && task.machine === config.machine);
  // A check whose task no longer waits here is left over: the user moved the card, or the task was closed. One whose task is
  // still running may be about to wait (`board wait` stores the check first), so it stays.
  const keep = new Set(
    tasks
      .filter((task) => (task.status === 'waiting' || task.status === 'running') && task.machine === config.machine)
      .map((task) => task.id),
  );
  for (const id of waits.list()) {
    if (keep.has(id) || !(await isGone(deps, id))) continue;
    deps.print(`DROP-CHECK ${id} its task no longer waits here`);
    if (!deps.dryRun) waits.remove(id);
  }
  const checks: Task[] = [];
  const replaced = new Map<string, Task>();
  for (const task of waiting) {
    const decision = decideWake({ task, check: waits.read(task.id), machine: config.machine, now: deps.now() });
    if (decision.kind === 'check') checks.push(task);
    if (decision.kind === 'wake' || decision.kind === 'timeout') {
      const after = await wakeTask(deps, task, decision.why);
      if (after) replaced.set(task.id, after);
    }
  }
  return { tasks: tasks.map((task) => replaced.get(task.id) ?? task), checks };
}

// The tick is stopped after 110 s, and the check processes would outlive it: they run in their own process group.
const TICK_LIMIT_MS = 110_000;
const TICK_MARGIN_MS = 10_000;

// The due checks, side by side; a check that passes wakes its task, any other result is kept for the next attempt. Checks that
// would not finish before the tick's limit wait for the next tick.
async function runChecks(deps: DispatchDeps, checks: Task[], tickStart: Date): Promise<void> {
  if (checks.length === 0) return;
  const left = TICK_LIMIT_MS - TICK_MARGIN_MS - (deps.now().getTime() - tickStart.getTime());
  if (left < CHECK_TIME_LIMIT_MS) {
    deps.print(`DEFER-CHECKS ${checks.length}: the tick has ${Math.max(0, Math.round(left / 1000))} s left`);
    return;
  }
  await Promise.all(
    checks.map(async (task) => {
      const check = deps.waits.read(task.id);
      if (check === undefined) return;
      if (deps.dryRun) {
        deps.print(`DRY check ${task.id} in ${check.cwd}`);
        return;
      }
      const at = deps.now();
      const result = await deps.runCheck(check);
      if (result.exitCode === 0) {
        await wakeTask(deps, task, `its check passed.${checkOutputBlock(result.output)}`);
        return;
      }
      deps.print(`CHECK ${task.id} ${result.timedOut ? 'too slow' : `exit ${result.exitCode ?? 'killed'}`}`);
      // The task may have been woken or moved meanwhile; then the file is gone and stays gone.
      if (deps.waits.read(task.id) === undefined) return;
      deps.waits.write(task.id, { ...check, lastCheckAt: at, lastExit: result.exitCode, lastOutput: result.output });
    }),
  );
}

export async function runDispatch(deps: DispatchDeps): Promise<void> {
  const { backend, config, system, files, print: log } = deps;
  const tickStart = deps.now();
  const listed = await backend.listTasks();
  // The unit of a task lives on the machine that claimed it; another machine's tasks are its own business.
  const running = listed.filter(
    (task) => task.status === 'running' && (task.machine === null || task.machine === config.machine),
  );

  for (const task of running) {
    const unit = unitName(task.id);
    const unitActive = await system.isActive(unit);
    // The unit knows when this run began, to the second; the claim is the board's record of it.
    const unitStart = unitActive ? await system.startedAt(unit) : undefined;
    const decision = decideStale({
      unitActive,
      startedAt: unitStart ?? task.runStartedAt ?? undefined,
      lastActive: files.lastActive(task.id),
      now: deps.now(),
      limits: config,
    });
    if (!decision.stale) continue;
    if (decision.stopUnit) await system.stop(unit);
    if (!deps.dryRun) files.clear(task.id);
    log(`STALE ${task.id} ${decision.reason}`);
    const tail = deps.logTail(task.id);
    await deps.backend.fail(task.id, `${decision.reason}\n\nEnd of the log:\n${fence(tail || '(empty)')}`);
  }

  const { tasks, checks } = await wakeDue(deps, listed);

  // What runs here, per lane: every active worker unit, whatever the board says, with the lane its run file names.
  const activeWorkers = await system.activeWorkers();
  const runs = await Promise.all(
    activeWorkers.map(async (taskId): Promise<LaneRun> => {
      const record = files.readRun(taskId);
      return {
        taskId,
        lane: record?.lane ?? config.lanes[0]?.name ?? 'default',
        borrowed: record?.borrowed ?? false,
        startedAt: record?.startedAt ?? (await system.startedAt(unitName(taskId))),
        pauseRequested: files.pauseRequestedAt(taskId) !== undefined,
      };
    }),
  );

  const candidates: Task[] = [];
  // The backend lists Todo with resumes first, then by priority.
  for (const task of tasks.filter((candidate) => candidate.status === 'todo')) {
    // A task put back in Todo (an answer came while the agent was still ending its turn) must not start twice.
    if (activeWorkers.includes(task.id)) {
      log(`SKIP ${task.id} its last worker is still stopping`);
      continue;
    }
    // An agent's proposal waits for the user, whatever status the board shows. The worker refuses it as well.
    if (neverRun(task) !== undefined) {
      log(`SKIP ${task.id} proposed by an agent, not started by you`);
      continue;
    }
    // A prompt or directory this machine cannot decrypt must never be run as an empty one. The worker refuses it as well.
    const unreadable = unreadableForRun(task);
    if (unreadable.length > 0) {
      log(`SKIP ${task.id} cannot decrypt its ${unreadable.join(' and ')}`);
      continue;
    }
    // Not due yet; the board refuses the claim too, this only saves the attempt every tick. Checked before
    // notServableHere so no other machine logs a SKIP line for every delayed card on every tick.
    if (task.notBefore !== null && task.notBefore > deps.now()) continue;
    // Another machine may have the checkout, the directory or the session.
    const elsewhere = notServableHere(task, config.machine, config.repos);
    if (elsewhere !== undefined) {
      log(`SKIP ${task.id} ${elsewhere}`);
      continue;
    }
    candidates.push(task);
  }

  const ownLaneOf = (task: Task) => ownLane(task, config.lanes);
  const started = new Set<string>();
  const tried = new Set<string>();
  // One start at a time, planned again after each: a lost claim hands its slot to the next task.
  for (;;) {
    const open = candidates.filter((candidate) => !tried.has(candidate.id));
    const start = planStarts({ lanes: config.lanes, running: runs, candidates: open, ownLaneOf })[0];
    if (start === undefined) break;
    tried.add(start.taskId);
    const task = open.find((candidate) => candidate.id === start.taskId);
    if (!task) continue;
    const skill = promptSkill(task.input) ?? 'prompt';
    if ((await backend.claimTask(task.id, config.machine)) === undefined) {
      log(`LOST ${task.id} claimed elsewhere`);
      continue;
    }
    // Written before the unit starts: the worker and the next tick read the lane from it.
    if (!deps.dryRun) {
      files.clear(task.id);
      files.writeRun(task.id, { lane: start.lane, borrowed: start.borrowed, startedAt: deps.now() });
    }
    let pid: number | undefined;
    try {
      ({ pid } = await system.startWorker(task.id));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`START-FAILED ${task.id} ${reason}`);
      if (!deps.dryRun) files.clear(task.id);
      await deps.backend.fail(task.id, `The worker could not be started: ${reason}`);
      // Whatever broke it will break the next start too.
      break;
    }
    started.add(task.id);
    runs.push({
      taskId: task.id,
      lane: start.lane,
      borrowed: start.borrowed,
      startedAt: deps.now(),
      pauseRequested: false,
    });
    log(`STARTED ${task.id} ${skill} lane=${start.lane}${start.borrowed ? ' borrowed' : ''}`);
    const where = `${start.lane} lane${start.borrowed ? ', borrowed' : ''}, unit ${unitName(task.id)}${pid ? `, pid ${pid}` : ''}`;
    await backend
      .addNote(task.id, `${START_MARKER} ${deps.now().toISOString()} (${skill}, ${config.machine}, ${where})`, {
        author: 'system',
      })
      .catch((error: unknown) => {
        log(`WARN start note failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  // Lanes whose own work still waits take their slots back from borrowed runs.
  const waitingOwn = new Map<string, number>();
  for (const task of candidates) {
    if (started.has(task.id)) continue;
    const lane = ownLaneOf(task);
    if (lane !== undefined) waitingOwn.set(lane, (waitingOwn.get(lane) ?? 0) + 1);
  }
  for (const run of planPauses({
    lanes: config.lanes,
    running: runs,
    waitingOwn,
    now: deps.now(),
    pauseAfterMinutes: config.pauseAfterMinutes,
  })) {
    log(`PAUSE ${run.taskId} lane=${run.lane} (its own work waits)`);
    if (deps.dryRun) continue;
    try {
      files.requestPause(run.taskId);
    } catch (error) {
      log(`WARN pause request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const summary = config.lanes
    .map((lane) => `${lane.name}=${runs.filter((run) => run.lane === lane.name).length}/${lane.slots}`)
    .join(' ');
  await runChecks(deps, checks, tickStart);
  log(`TICK started=${started.size} ${summary}${checks.length > 0 ? ` checks=${checks.length}` : ''}`);
}

export async function dispatchMain({ dryRun }: { dryRun: boolean }): Promise<void> {
  const context = buildContext(dryRun);
  await skipTickWhileServerOlder(() =>
    runDispatch({
      ...context,
      print,
      system: createSystem({ dryRun, print }),
      files: createRunFiles(),
      now: () => new Date(),
      logTail: readLogTail,
      waits: createWaitStore(),
      runCheck: (check) => runCheck(check),
    }),
  );
}
