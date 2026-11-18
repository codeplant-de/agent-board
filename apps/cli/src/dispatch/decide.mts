import type { AgentConfig, Lane } from '../config/config.mts';
import type { Task } from '@agent-board/shared';
import { fence } from '../output/text.mts';
import { agentFor } from '../task-rules.mts';
import type { RunLimits } from '../worker/plan.mts';
import { wakeReason } from '../watch/wake.mts';

// The worker enforces the timeout itself; the sweep only catches a worker that cannot.
const SWEEP_GRACE_MINUTES = 5;

export type StaleDecision = { stale: false } | { stale: true; reason: string; stopUnit: boolean };

// The worker enforces the limits itself; this catches a worker that cannot, a few minutes after it should have.
export function decideStale(input: {
  unitActive: boolean;
  startedAt: Date | undefined;
  // The agent's last tool call; undefined before its first one.
  lastActive: Date | undefined;
  now: Date;
  limits: RunLimits;
  // The machine slept since the last tick: how long the agent was quiet says nothing until its worker has noticed the
  // wake (it moves the agent's last sign of life forward on its next 15 s tick).
  afterGap?: boolean;
}): StaleDecision {
  if (!input.unitActive) return { stale: true, reason: 'The worker is no longer running.', stopUnit: false };
  if (input.startedAt === undefined) return { stale: false };
  const minutesSince = (date: Date) => (input.now.getTime() - date.getTime()) / 60_000;
  const age = minutesSince(input.startedAt);
  if (age > input.limits.maxRunHours * 60 + SWEEP_GRACE_MINUTES) {
    return {
      stale: true,
      reason: `The run has gone on for ${Math.round(age)} minutes, over the limit of ${input.limits.maxRunHours} hours.`,
      stopUnit: true,
    };
  }
  if (input.afterGap) return { stale: false };
  const quiet = minutesSince(input.lastActive ?? input.startedAt);
  if (quiet > input.limits.inactivityMinutes + SWEEP_GRACE_MINUTES) {
    return { stale: true, reason: `The agent has made no tool call for ${Math.round(quiet)} minutes.`, stopUnit: true };
  }
  return { stale: false };
}

export interface LaneRun {
  taskId: string;
  lane: string;
  borrowed: boolean;
  startedAt: Date | undefined;
  pauseRequested: boolean;
}

export interface Start {
  taskId: string;
  lane: string;
  borrowed: boolean;
}

/**
 * Which todo tasks start in which lane. First every lane takes its own work, in list order; then lanes with slots
 * left borrow what is still waiting, in list order, earlier lanes first. `candidates` are the tasks this machine can
 * serve, in the backend's order (resumes first, then priority).
 */
export function planStarts(input: {
  lanes: Lane[];
  running: LaneRun[];
  candidates: Task[];
  ownLaneOf: (task: Task) => string;
}): Start[] {
  const free = new Map(
    input.lanes.map((lane) => [lane.name, lane.slots - input.running.filter((run) => run.lane === lane.name).length]),
  );
  const starts: Start[] = [];
  const taken = new Set<string>();
  for (const task of input.candidates) {
    const lane = input.ownLaneOf(task);
    if ((free.get(lane) ?? 0) > 0) {
      starts.push({ taskId: task.id, lane, borrowed: false });
      free.set(lane, (free.get(lane) ?? 0) - 1);
      taken.add(task.id);
    }
  }
  for (const task of input.candidates) {
    if (taken.has(task.id)) continue;
    const lane = input.lanes.find((candidate) => (free.get(candidate.name) ?? 0) > 0);
    if (lane === undefined) break;
    starts.push({ taskId: task.id, lane: lane.name, borrowed: true });
    free.set(lane.name, (free.get(lane.name) ?? 0) - 1);
  }
  return starts;
}

/**
 * Borrowed runs to pause: one per lane that is full, has its own work waiting and no pause pending, the borrowed run
 * that started last among those that ran at least `pauseAfterMinutes`. Lane bias beats priority, so the priorities
 * of the waiting and the running task do not matter.
 */
export function planPauses(input: {
  lanes: Lane[];
  running: LaneRun[];
  waitingOwn: Map<string, number>;
  now: Date;
  pauseAfterMinutes: number;
}): LaneRun[] {
  const pauses: LaneRun[] = [];
  for (const lane of input.lanes) {
    const inLane = input.running.filter((run) => run.lane === lane.name);
    if (inLane.length < lane.slots || (input.waitingOwn.get(lane.name) ?? 0) === 0) continue;
    if (inLane.some((run) => run.pauseRequested)) continue;
    const pausable = inLane
      .filter(
        (run) =>
          run.borrowed &&
          run.startedAt !== undefined &&
          input.now.getTime() - run.startedAt.getTime() >= input.pauseAfterMinutes * 60_000,
      )
      .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
    if (pausable[0]) pauses.push(pausable[0]);
  }
  return pauses;
}

/**
 * When planPauses will next find a borrowed run to pause: the first moment a borrowed run reaches `pauseAfterMinutes` in a lane
 * that is full, has its own work waiting and no pause pending. Undefined when no lane will.
 */
export function nextPauseAt(input: {
  lanes: Lane[];
  running: LaneRun[];
  waitingOwn: Map<string, number>;
  now: Date;
  pauseAfterMinutes: number;
}): Date | undefined {
  let next: number | undefined;
  for (const lane of input.lanes) {
    const inLane = input.running.filter((run) => run.lane === lane.name);
    if (inLane.length < lane.slots || (input.waitingOwn.get(lane.name) ?? 0) === 0) continue;
    if (inLane.some((run) => run.pauseRequested)) continue;
    for (const run of inLane) {
      if (!run.borrowed || run.startedAt === undefined) continue;
      const at = run.startedAt.getTime() + input.pauseAfterMinutes * 60_000;
      if (at > input.now.getTime() && (next === undefined || at < next)) next = at;
    }
  }
  return next === undefined ? undefined : new Date(next);
}

// A task with its own directory runs only on the machine it was scheduled on.
export function pinnedMachine(task: Task): string | undefined {
  if (task.next === 'resume' && task.sessionId !== null && task.machine !== null) return task.machine;
  if (task.workdir !== null && task.machine !== null) return task.machine;
  return undefined;
}

// Why this machine leaves a todo task to another one, or undefined when it can run it.
export function notServableHere(
  task: Task,
  machine: string,
  config: {
    agents: Record<string, AgentConfig>;
    agentErrors: Record<string, string>;
  },
): string | undefined {
  const pinned = pinnedMachine(task);
  if (pinned !== undefined && pinned !== machine) return `pinned to ${pinned}`;
  const agent = agentFor(task, config);
  // A pinned task is claimed here and refused by the worker with a note: skipped, it would sit in Todo for good.
  if (agent.kind === 'missing' && pinned === undefined) return agent.reason;
  return undefined;
}

const CHECK_SLACK_MS = 20_000;

export type WakeDecision =
  | { kind: 'sleep' }
  | { kind: 'check' }
  | { kind: 'wake'; why: string }
  // The check's time is up: wake, with what its last attempt said.
  | { kind: 'timeout'; why: string };

// The end of a check's output, fenced for the thread. It stays out of the resume prompt (see `wokenLine`).
export function checkOutputBlock(output: string | undefined): string {
  const text = (output ?? '').trimEnd();
  if (text === '') return '';
  return `\n\nEnd of its output:\n${fence(text.split('\n').slice(-20).join('\n'))}`;
}

/**
 * What the dispatcher of the task's machine does with a waiting task: wake it when its time is up (a timer's end, a check's
 * timeout) or its check is missing, run its check when one is due, or leave it. A watch event nobody was handed wakes it too.
 */
export function decideWake(input: {
  task: Pick<Task, 'wakeAt' | 'waitCheck'>;
  // The check stored on this machine, if any.
  check: { everyMs: number; lastCheckAt?: Date; lastExit?: number | null; lastOutput?: string } | undefined;
  machine: string;
  now: Date;
  // This machine holds watches of the task. They stand in for a stored check: without one the task sleeps until `wakeAt`.
  watches?: boolean;
  // The name of the oldest watch event waiting for the task, when no worker runs for it.
  event?: string;
}): WakeDecision {
  const { task, check, now } = input;
  if (input.event !== undefined) return { kind: 'wake', why: wakeReason(input.event) };
  const due = task.wakeAt === null || task.wakeAt.getTime() <= now.getTime();
  if (!task.waitCheck || (check === undefined && input.watches === true))
    return due ? { kind: 'wake', why: 'its time ran out.' } : { kind: 'sleep' };
  if (check === undefined)
    return {
      kind: 'wake',
      why: `its check is no longer stored on ${input.machine}, so nothing could end it. Find out yourself whether what you waited for is done.`,
    };
  if (due) {
    const last =
      check.lastCheckAt === undefined
        ? 'It never ran.'
        : `Its last attempt ended ${check.lastExit === null || check.lastExit === undefined ? 'without an exit code (killed or too slow)' : `with exit code ${check.lastExit}`}.`;
    return {
      kind: 'timeout',
      why: `the check did not pass before its timeout. ${last}${checkOutputBlock(check.lastOutput)}`,
    };
  }
  // A little early is on time: ticks come every two minutes, give or take, and a check every 2m must not slip to every 4m.
  if (check.lastCheckAt === undefined || now.getTime() - check.lastCheckAt.getTime() >= check.everyMs - CHECK_SLACK_MS)
    return { kind: 'check' };
  return { kind: 'sleep' };
}
