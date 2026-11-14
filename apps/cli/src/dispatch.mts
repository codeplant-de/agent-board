/**
 * One dispatcher tick: sweep stale Running tasks, then fill free slots from the top of Todo.
 * No LLM calls. Add --dry-run to read everything and print every write and process start instead.
 */
import { buildContext, print } from './cli.mts';
import type { Context } from './cli.mts';
import type { Task } from '@agent-board/shared';
import { promptSkill } from '@agent-board/shared';
import {
  decideStale,
  notServableHere,
  ownLane,
  planPauses,
  planStarts,
  START_MARKER,
  unitName,
  unreadableForRun,
} from './decide.mts';
import type { LaneRun } from './decide.mts';
import { createRunFiles } from './runtime.mts';
import type { RunFiles } from './runtime.mts';
import { createSystem } from './system.mts';
import type { System } from './system.mts';
import { postSlack, slackText } from './notify.mts';
import { readLogTail } from './logs.mts';
import { sendToNeedsMe } from './report.mts';
import { fence } from './text.mts';

export interface DispatchDeps extends Context {
  system: System;
  files: RunFiles;
  now: () => Date;
  logTail: (taskId: string) => string;
  notify: (task: Task, text: string) => Promise<void>;
}

export async function runDispatch(deps: DispatchDeps): Promise<void> {
  const { backend, config, system, files, print: log } = deps;
  const tasks = await backend.listTasks();
  // The unit of a task lives on the machine that claimed it; another machine's tasks are its own business.
  const running = tasks.filter(
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
    await sendToNeedsMe(deps, task, `${decision.reason}\n\nEnd of the log:\n${fence(tail || '(empty)')}`);
  }

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
    // A prompt or directory this machine cannot decrypt must never be run as an empty one. The worker refuses it as well.
    const unreadable = unreadableForRun(task);
    if (unreadable.length > 0) {
      log(`SKIP ${task.id} cannot decrypt its ${unreadable.join(' and ')}`);
      continue;
    }
    // Not due yet; the board refuses the claim too, this only saves the attempt every tick. Checked before
    // notServableHere so no other machine logs a SKIP line for every waiting card on every tick.
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
      await sendToNeedsMe(deps, task, `The worker could not be started: ${reason}`);
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
  log(`TICK started=${started.size} ${summary}`);
}

export async function dispatchMain({ dryRun }: { dryRun: boolean }): Promise<void> {
  const context = buildContext(dryRun);
  await runDispatch({
    ...context,
    print,
    system: createSystem({ dryRun, print }),
    files: createRunFiles(),
    now: () => new Date(),
    logTail: readLogTail,
    notify: async (task, text) => {
      if (dryRun) return print(`DRY slack ${task.id} ${text}`);
      await postSlack(context.config.slackWebhookFile, slackText(task, text));
    },
  });
}
