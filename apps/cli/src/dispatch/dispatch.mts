/**
 * One dispatcher tick: sweep stale Running tasks, wake waiting tasks whose time is up, fill free slots from the top of Todo,
 * then drop the logs and session records of finished tasks and run the checks of waiting tasks that are due.
 * No LLM calls. Add --dry-run to read everything and print every write and process start instead.
 */
import { isBehind, tryUpdate } from '../self/auto-update.mts';
import type { UpdateDeps } from '../self/auto-update.mts';
import { BackendError, isVocabularyRefusal } from '../backend/backend.mts';
import { updateCliHint } from '../backend/contract-check.mts';
import { buildContext, print, skipTickWhileServerOlder } from '../cli.mts';
import type { Context } from '../cli.mts';
import type { Task } from '@agent-board/shared';
import { promptSkill } from '@agent-board/shared';
import { checkOutputBlock, decideStale, decideWake, notServableHere, planPauses, planStarts } from './decide.mts';
import { neverRun, ownLane, START_MARKER, unreadableForRun, WAKE_MARKER } from '../task-rules.mts';
import { unitName } from '../task-id.mts';
import type { LaneRun } from './decide.mts';
import { syncDirs } from '../config/dirs.mts';
import { createRunFiles } from '../worker/runtime.mts';
import type { RunFiles } from '../worker/runtime.mts';
import { EXEC_PATH, isCompiledBinary } from '../self/self.mts';
import { realGh, realListenerRestart, selfUpdate } from '../self/self-update.mts';
import { createSystem } from '../setup/system.mts';
import type { System } from '../setup/system.mts';
import { readLogTail } from '../worker/logs.mts';
import { createTaskFileStore } from './task-files.mts';
import type { TaskFileStore } from './task-files.mts';
import { errorText, fence } from '../output/text.mts';
import type { CheckResult, WaitCheck, WaitStore } from './waits.mts';
import { CHECK_TIME_LIMIT_MS, createWaitStore, runCheck } from './waits.mts';
import { createUpdateState, updateStateFile } from '../self/update-state.mts';
import { cliVersion, releaseVersion } from '../self/version.mts';
import { getPaths, loadConfigWarnings } from '../config/config.mts';

export interface DispatchDeps extends Context {
  system: System;
  files: RunFiles;
  now: () => Date;
  logTail: (taskId: string) => string;
  waits: WaitStore;
  taskFiles: TaskFileStore;
  runCheck: (check: WaitCheck) => Promise<CheckResult>;
  update: UpdateDeps;
  // Keys of config.json the CLI ignores (see configWarnings), logged at the start of every tick.
  configWarnings: () => string[];
}

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

// A finished task's log and session record are kept this long after they last changed: the log for the user to read, the
// record so a task moved back from Done can still be resumed.
export const TASK_FILES_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
// Tasks the list does not show are looked up one by one; a machine with a long history clears them over a few ticks.
const TASK_FILE_LOOKUPS_PER_TICK = 20;

// Whether a task the list does not show is finished: closed, done, or gone from the board. A task the board hides from this
// CLI, or one that cannot be read now, is not.
async function isFinished(deps: DispatchDeps, id: string): Promise<boolean> {
  try {
    const task = await deps.backend.getTask(id);
    return task.closed || task.status === 'done';
  } catch (error) {
    return error instanceof BackendError && error.fromApi && error.status === 404;
  }
}

/**
 * Drops the logs and session records of tasks that are done, closed or gone, once the files are older than TASK_FILES_KEEP_MS.
 * Every other task keeps its files: one in Running, Waiting or Todo may resume its session, and one in Needs me or Backlog may
 * be sent back to Todo. The files of a task whose worker still runs here are kept whatever the board says.
 */
async function pruneTaskFiles(deps: DispatchDeps, listed: Task[], activeWorkers: string[]): Promise<void> {
  const cutoff = deps.now().getTime() - TASK_FILES_KEEP_MS;
  const old = deps.taskFiles.list().filter((file) => file.modifiedAt.getTime() < cutoff);
  const shown = new Map(listed.map((task) => [task.id, task]));
  let lookups = 0;
  for (const id of new Set(old.map((file) => file.taskId))) {
    if (activeWorkers.includes(id)) continue;
    const task = shown.get(id);
    if (task === undefined && lookups >= TASK_FILE_LOOKUPS_PER_TICK) continue;
    if (task === undefined) lookups += 1;
    if (!(task === undefined ? await isFinished(deps, id) : task.status === 'done')) continue;
    for (const file of old.filter((candidate) => candidate.taskId === id)) {
      deps.print(`DROP-${file.kind.toUpperCase()} ${id} its task is finished`);
      if (!deps.dryRun) deps.taskFiles.remove(file);
    }
  }
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

// Tells the board this machine's directory list when it changed; a server that cannot hold one or a failure costs one line at most.
async function sendDirs({ backend, config, print: log }: DispatchDeps): Promise<void> {
  try {
    const sync = await syncDirs({ backend, config });
    if (sync.result === 'sent') log(`DIRS sent ${sync.count} directories to the board`);
  } catch (error) {
    log(`WARN sending the directory list failed: ${errorText(error)}`);
  }
}

const updateRun = ({ update, now, print: log, dryRun }: DispatchDeps) => ({ ...update, now, log, dryRun });

export async function runDispatch(deps: DispatchDeps): Promise<void> {
  const { backend, config, system, files, print: log } = deps;
  const tickStart = deps.now();
  for (const warning of deps.configWarnings()) log(`WARN config.json: ${warning}`);
  for (const reason of Object.values(config.agentErrors))
    log(`WARN config.json: ${reason}; tasks that name this agent are not run`);
  let listed: Task[];
  try {
    listed = await backend.listTasks();
  } catch (error) {
    // A board that has moved on refuses this CLI; with the config's leave the dispatcher fetches the CLI that fits.
    if (!(error instanceof BackendError) || error.contractMismatch !== 'cli-older' || config.autoUpdate === 'never')
      throw error;
    const outcome = await tryUpdate(updateRun(deps), 'this CLI is too old for the board');
    // Failing or waiting out a failure ends the tick quietly: it must not alert on every tick.
    if (outcome === 'unavailable') throw error;
    return;
  }
  const advertised = deps.update.advertised();
  if (config.autoUpdate === 'always' && isBehind({ advertised, version: deps.update.version })) {
    const workers = await system.activeWorkers();
    const why = `board ${advertised} is available (this is ${deps.update.version})`;
    // Workers call this binary again (their hook), so it is replaced only while none runs; the next tick looks again.
    if (workers.length > 0) log(`UPDATE-WAIT ${why}; ${workers.length} worker(s) running`);
    else if ((await tryUpdate(updateRun(deps), why)) === 'updated') return;
  }
  await sendDirs(deps);
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
    const elsewhere = notServableHere(task, config.machine, config.repos, config);
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
      const reason = errorText(error);
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
        log(`WARN start note failed: ${errorText(error)}`);
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
      log(`WARN pause request failed: ${errorText(error)}`);
    }
  }
  const summary = config.lanes
    .map((lane) => `${lane.name}=${runs.filter((run) => run.lane === lane.name).length}/${lane.slots}`)
    .join(' ');
  try {
    await pruneTaskFiles(deps, listed, activeWorkers);
  } catch (error) {
    log(`WARN dropping old task files failed: ${errorText(error)}`);
  }
  await runChecks(deps, checks, tickStart);
  log(`TICK started=${started.size} ${summary}${checks.length > 0 ? ` checks=${checks.length}` : ''}`);
}

export async function dispatchMain({ dryRun }: { dryRun: boolean }): Promise<void> {
  const context = buildContext(dryRun);
  const compiled = isCompiledBinary();
  await skipTickWhileServerOlder(() =>
    runDispatch({
      ...context,
      print,
      update: {
        compiled,
        version: cliVersion(),
        advertised: () => context.serverCli?.(),
        state: createUpdateState(updateStateFile(getPaths().stateDir)),
        update: () =>
          selfUpdate(
            {
              compiled,
              version: releaseVersion(),
              execPath: EXEC_PATH,
              platform: process.platform,
              arch: process.arch,
              // Below the tick's 110 s limit, so a stalled download fails instead of being killed with the tick.
              gh: realGh(process.env, 90_000),
              // The dispatcher runs inside the listener's unit, whose stop waits for it: asking must not wait for the stop.
              restartListener: realListenerRestart({ block: false }),
              print,
            },
            {},
          ),
      },
      system: createSystem({ dryRun, print }),
      files: createRunFiles(),
      now: () => new Date(),
      logTail: readLogTail,
      waits: createWaitStore(),
      taskFiles: createTaskFileStore(),
      runCheck: (check) => runCheck(check),
      configWarnings: () => loadConfigWarnings(getPaths().configFile),
    }),
  );
}
