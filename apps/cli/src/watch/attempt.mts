// One look at a watch: what it says now. The watch unit and the dispatcher's tick (when the unit is not running) both ask it, and so
// does `board watch` before it stores a watch, so a command that cannot run here fails at once and not two hours later.
import { formatDuration } from '@agent-board/shared';
import { localTime } from '../commands/schedule.mts';
import type { CommandResult } from '../dispatch/waits.mts';
import { ciChecksCommand, ciViewCommand, decideCi, isViewOpen } from './ci.mts';
import type { CiSource } from './ci.mts';
import { deadlineTime } from './fence.mts';
import type { WatchDef } from './store.mts';

export const UNIT_ATTEMPT_LIMIT_MS = 120_000;
export const TICK_ATTEMPT_LIMIT_MS = 45_000;
// gh is asked twice per ci attempt, each call with this at the most.
const CI_CALL_LIMIT_MS = 60_000;
const OUTPUT_SUMMARY_CHARS = 2000;

export interface RunJob {
  command: string;
  cwd: string;
  settingsDir?: string;
  timeLimitMs: number;
  signal?: AbortSignal;
}

// Runs a shell command the way the agent would have (see `runCommand`); injected so tests do not start processes.
export type WatchRunner = (job: RunJob) => Promise<CommandResult>;

export interface AttemptDeps {
  run: WatchRunner;
  // How long a command watch's attempt may take.
  timeLimitMs: number;
  // At registration: a watch that cannot run here is `broken`, not pending.
  registration?: boolean;
  signal?: AbortSignal;
}

export type AttemptResult =
  // The watch is over; the text is the report.
  | { kind: 'event'; text: string }
  // Still going. `def` is the watch as the attempt leaves it, when that differs (a ci watch that moved to a new head).
  | { kind: 'pending'; summary: string; def?: WatchDef }
  | { kind: 'broken'; reason: string };

/** When a polled watch is next due: `everyMs` after its last attempt, or after it was registered (which ran the first one). */
export function nextAttemptAt(def: Pick<WatchDef, 'last' | 'createdAt' | 'everyMs'>): number {
  return Date.parse(def.last?.at ?? def.createdAt) + def.everyMs;
}

function sourceOf(def: WatchDef, source: CiSource): WatchDef {
  return { ...def, source };
}

function exitWord(result: CommandResult): string {
  if (result.timedOut) return 'too slow, stopped';
  return result.exitCode === null ? 'killed' : `exit ${result.exitCode}`;
}

async function attemptCommand(
  def: WatchDef & { source: { kind: 'command' } },
  deps: AttemptDeps,
): Promise<AttemptResult> {
  const { command, cwd, settingsDir } = def.source;
  const result = await deps.run({
    command,
    cwd,
    timeLimitMs: deps.timeLimitMs,
    ...(settingsDir === undefined ? {} : { settingsDir }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  const output = result.output.trimEnd();
  if (result.exitCode === 0)
    return {
      kind: 'event',
      text: output === '' ? 'Exit 0. It printed nothing.' : `Exit 0. End of its output:\n${output}`,
    };
  if (
    deps.registration === true &&
    (result.exitCode === 126 || result.exitCode === 127 || (result.exitCode === null && !result.timedOut))
  )
    return {
      kind: 'broken',
      reason: `the command cannot run in ${cwd}: ${output === '' ? exitWord(result) : output.split('\n').slice(-3).join(' ')}`,
    };
  const end = output === '' ? '' : `: ${output.slice(-OUTPUT_SUMMARY_CHARS)}`;
  return { kind: 'pending', summary: `${exitWord(result)}${end}`.slice(0, OUTPUT_SUMMARY_CHARS + 20) };
}

async function attemptCi(def: WatchDef & { source: CiSource }, now: Date, deps: AttemptDeps): Promise<AttemptResult> {
  const { source } = def;
  const job = (command: string): RunJob => ({
    command,
    cwd: source.cwd,
    timeLimitMs: Math.min(CI_CALL_LIMIT_MS, deps.timeLimitMs),
    ...(source.settingsDir === undefined ? {} : { settingsDir: source.settingsDir }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
  const view = await deps.run(job(ciViewCommand(source.pr)));
  const checks = isViewOpen(view) ? await deps.run(job(ciChecksCommand(source.pr, source.required))) : undefined;
  const decision = decideCi({ source, now, view, ...(checks === undefined ? {} : { checks }) });
  if (decision.kind === 'event') return { kind: 'event', text: decision.text };
  if (decision.kind === 'pending')
    return { kind: 'pending', summary: decision.summary, def: sourceOf(def, decision.source) };
  if (deps.registration === true) return { kind: 'broken', reason: decision.reason };
  return { kind: 'pending', summary: decision.reason };
}

/**
 * Looks at one watch. A timer is never polled: its end is its event. Every other source returns its event, or its state.
 */
export async function attempt(def: WatchDef, now: Date, deps: AttemptDeps): Promise<AttemptResult> {
  const { source } = def;
  if (source.kind === 'timer')
    return now.getTime() >= Date.parse(def.deadline)
      ? { kind: 'event', text: timerText(def) }
      : { kind: 'pending', summary: `waiting until ${deadlineTime(new Date(def.deadline), now)}` };
  if (source.kind === 'command') return attemptCommand({ ...def, source }, deps);
  return attemptCi({ ...def, source }, now, deps);
}

export function timerText(def: Pick<WatchDef, 'createdAt'>): string {
  return `Time is up (set ${localTime(new Date(def.createdAt))}).`;
}

/** What the watch reports when its deadline passed without an event. */
export function timeoutText(def: Pick<WatchDef, 'name' | 'createdAt' | 'deadline' | 'last'>): string {
  const after = formatDuration(Date.parse(def.deadline) - Date.parse(def.createdAt));
  const last =
    def.last === undefined ? 'It never ran.' : `Last attempt ${localTime(new Date(def.last.at))}: ${def.last.summary}`;
  return `Watch "${def.name}" timed out after ${after} (${localTime(new Date(def.deadline))}). ${last}`;
}

/** The kind and text a watch whose deadline passed ends with: a timer's end is its event, anything else times out. */
export function deadlineReport(def: WatchDef): { kind: 'event' | 'timeout'; text: string } {
  return def.source.kind === 'timer'
    ? { kind: 'event', text: timerText(def) }
    : { kind: 'timeout', text: timeoutText(def) };
}
