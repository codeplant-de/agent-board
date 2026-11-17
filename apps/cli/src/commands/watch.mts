// `board watch`, `board watches` and `board unwatch`: the commands over the watches of a task on this machine (see watch/store.mts).
import { ContractError, formatDuration, isRecord, MAX_WAIT_MS, parseDuration } from '@agent-board/shared';
import type { Task, TaskPr } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import type { Context } from '../cli.mts';
import { oneLine, shellQuote } from '../output/text.mts';
import { attempt, UNIT_ATTEMPT_LIMIT_MS } from '../watch/attempt.mts';
import type { AttemptResult, WatchRunner } from '../watch/attempt.mts';
import { describeEvery, eventsMessage, sanitizeEventText } from '../watch/fence.mts';
import { CI_EVERY_MS, MAX_COMMAND_CHARS, MIN_COMMAND_EVERY_MS, newWatchId } from '../watch/store.mts';
import type { WatchDef, WatchStore } from '../watch/store.mts';
import { isPrUrl, isWatchName } from '../watch/shapes.mts';
import { confirm } from './board.mts';
import { localTime, parseStart } from './schedule.mts';

export interface WatchFlags {
  // `--ci` alone is true; `--ci <pr>` carries the PR.
  ci?: string | true;
  required?: boolean;
  name?: string;
  every?: string;
  timeout?: string;
  in?: string;
  at?: string;
}

export const DEFAULT_WATCH_EVERY = '30s';
export const DEFAULT_WATCH_TIMEOUT = '2h';
export const KEEP_WORKING =
  'Keep working if there is work; end your turn when there is none: the task waits and resumes with the event.';

const PR_NUMBER = /^[1-9]\d{0,8}$/;
const PR_RESOLVE_LIMIT_MS = 60_000;

export type WatchPlan = {
  name: string;
  deadline: Date;
} & (
  | { kind: 'ci'; pr: string | undefined; required: boolean }
  | { kind: 'command'; command: string; everyMs: number }
  | { kind: 'timer' }
);

// The shared durations start at the minute; a watch looks every 15 seconds at the least, so whole seconds ("30s") count too.
function duration(text: string, flag: string): number {
  const seconds = /^(\d{1,6})s$/.exec(text.trim());
  if (seconds !== null) return Number(seconds[1]) * 1000;
  try {
    return parseDuration(text);
  } catch (error) {
    if (error instanceof ContractError) throw new UsageError(`${flag}: ${error.message}`);
    throw error;
  }
}

function checkedName(name: string): string {
  if (!isWatchName(name))
    throw new UsageError(
      `--name must be 1-32 characters of lowercase letters, digits and hyphens, starting with a letter or digit; got "${oneLine(name, 40)}"`,
    );
  return name;
}

/**
 * What the flags and the words after `--` ask for. Exactly one source: `--ci`, a command, or `--in`/`--at`. Reads nothing: the
 * task and the PR are looked at afterwards.
 */
export function parseWatchFlags(flags: WatchFlags, words: string[], now: Date = new Date()): WatchPlan {
  const { ci, required, name, every, timeout, in: inText, at } = flags;
  if (inText !== undefined && at !== undefined) throw new UsageError('give --in or --at, not both');
  const sources = [ci !== undefined, words.length > 0, inText !== undefined || at !== undefined].filter(Boolean).length;
  if (sources !== 1)
    throw new UsageError(
      `give exactly one source: --ci for the CI of a PR, a command after -- (with --name), or --in/--at for a timer`,
    );
  if (required === true && ci === undefined) throw new UsageError('--required goes with --ci');
  const timeoutMs = (): number => {
    const ms = duration(timeout ?? DEFAULT_WATCH_TIMEOUT, '--timeout');
    if (ms > MAX_WAIT_MS) throw new UsageError(`--timeout may be at most ${formatDuration(MAX_WAIT_MS)}`);
    return ms;
  };
  if (ci !== undefined) {
    if (every !== undefined)
      throw new UsageError(`--every goes with a command; a CI watch looks every ${describeEvery(CI_EVERY_MS)}`);
    return {
      kind: 'ci',
      name: checkedName(name ?? 'ci'),
      pr: ci === true ? undefined : ci,
      required: required === true,
      deadline: new Date(now.getTime() + timeoutMs()),
    };
  }
  if (words.length > 0) {
    if (name === undefined) throw new UsageError('a command watch needs --name <name>: it tells the events apart');
    // One word is the shell command as written; several are the words of one command, quoted so they stay what was typed.
    const command = words.length === 1 ? (words[0] ?? '') : words.map(shellQuote).join(' ');
    if (command.trim() === '') throw new UsageError('the command after -- is empty');
    if (command.length > MAX_COMMAND_CHARS)
      throw new UsageError(`the command is longer than ${MAX_COMMAND_CHARS} characters; put it in a script`);
    const everyMs = duration(every ?? DEFAULT_WATCH_EVERY, '--every');
    if (everyMs < MIN_COMMAND_EVERY_MS)
      throw new UsageError(`--every must be at least ${describeEvery(MIN_COMMAND_EVERY_MS)}`);
    return {
      kind: 'command',
      name: checkedName(name),
      command,
      everyMs,
      deadline: new Date(now.getTime() + timeoutMs()),
    };
  }
  if (every !== undefined || timeout !== undefined)
    throw new UsageError('--every and --timeout go with --ci or a command; a timer ends at its time');
  const deadline = parseStart(inText === undefined ? { at } : { delay: inText }, now);
  if (deadline === undefined) throw new UsageError('give --in or --at');
  if (deadline.getTime() - now.getTime() > MAX_WAIT_MS)
    throw new UsageError(`a timer may last at most ${formatDuration(MAX_WAIT_MS)}`);
  return { kind: 'timer', name: checkedName(name ?? 'timer'), deadline };
}

export interface WatchDeps {
  watches: WatchStore;
  // Runs a shell command; the real one starts a process.
  run: WatchRunner;
  cwd: string;
  // The directory the run started in (AGENT_BOARD_START_DIR), whose settings the watch takes its `env` from.
  settingsDir?: string;
  // The run's AGENT_BOARD_RESTRICTED marker, which the worker sets on this machine for an agent's run.
  restricted?: boolean;
  // The task of the run (AGENT_BOARD_TASK); outside a run, absent.
  ownTask?: string;
  now?: Date;
}

function requireHere(context: Context, task: Task, what: string): void {
  if (task.machine !== context.config.machine)
    throw new UsageError(
      `${task.id} runs on ${task.machine ?? 'no machine'}, not on ${context.config.machine}: ${what} lives on the task's machine`,
    );
}

// A run may watch its own task only.
function requireOwnTask(id: string, ownTask: string | undefined): void {
  if (ownTask !== undefined && ownTask !== '' && ownTask !== id)
    throw new UsageError(`${id} is not the task of this run (${ownTask}): a run watches its own task only`);
}

async function openTask(context: Context, id: string, what: string): Promise<Task> {
  const task = await context.backend.getTask(id);
  requireHere(context, task, what);
  return task;
}

function settingsDirOf(deps: WatchDeps): { settingsDir?: string } {
  return deps.settingsDir === undefined ? {} : { settingsDir: deps.settingsDir };
}

// The PR `--ci` watches when none is given: the newest one the task reported with `board pr` that is still open (or whose
// state is not known yet), else the newest one.
export function reportedPr(prs: readonly TaskPr[]): string | null {
  const open = prs.filter((pr) => pr.state !== 'merged' && pr.state !== 'closed');
  return (open.at(-1) ?? prs.at(-1))?.url ?? null;
}

// The PR as gh prints it, and its head commit, from a URL or number (or the task's PR) read in the agent's directory.
async function resolvePr(
  id: string,
  given: string | undefined,
  taskPr: string | null,
  deps: WatchDeps,
): Promise<{ url: string; head: string }> {
  const arg = (given ?? taskPr)?.trim();
  if (arg === undefined || arg === '') throw new UsageError(`give the PR: board watch ${id} --ci <url>`);
  if (!isPrUrl(arg) && !PR_NUMBER.test(arg))
    throw new UsageError(`--ci takes a PR URL or number; got "${oneLine(arg, 60)}"`);
  const result = await deps.run({
    command: `gh pr view ${shellQuote(arg)} --json url,headRefOid`,
    cwd: deps.cwd,
    timeLimitMs: PR_RESOLVE_LIMIT_MS,
    ...settingsDirOf(deps),
  });
  let info: unknown;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    info = undefined;
  }
  const url = isRecord(info) ? info['url'] : undefined;
  const head = isRecord(info) ? info['headRefOid'] : undefined;
  if (
    result.exitCode !== 0 ||
    typeof url !== 'string' ||
    !isPrUrl(url) ||
    typeof head !== 'string' ||
    !/^[0-9a-f]{40}$/.test(head)
  )
    throw new UsageError(
      `cannot read the PR ${oneLine(arg, 60)} in ${deps.cwd}: ${oneLine(result.stderr || result.output || 'gh did not answer', 200)}`,
    );
  return { url, head };
}

/**
 * Starts a watch on a task of this machine. A ci or command watch is looked at once first, in the environment the watch unit uses:
 * a command that cannot run here fails the call, and one that already has its event reports it and stores nothing.
 */
export async function watch(
  context: Context,
  id: string,
  flags: WatchFlags,
  words: string[],
  deps: WatchDeps,
): Promise<void> {
  const now = deps.now ?? new Date();
  const plan = parseWatchFlags(flags, words, now);
  requireOwnTask(id, deps.ownTask);
  const task = await openTask(context, id, 'a watch');
  if (task.status !== 'running' && task.status !== 'waiting')
    throw new UsageError(`${id} is ${task.status}: only a running or waiting task can have a watch`);
  if (plan.kind === 'command') {
    // An agent's run allows a fixed list of commands; a command watch would run any command.
    // A run an older CLI started for the removed intake has its narrow list but no AGENT_BOARD_RESTRICTED.
    if (task.createdBy === 'intake')
      throw new UsageError(`${id} is a task of the removed intake: it may watch with --ci or --in/--at only`);
    if (deps.restricted === true)
      throw new UsageError(
        `${id} runs as an agent with a fixed list of commands: it may watch with --ci or --in/--at only`,
      );
  }
  const base = {
    id: newWatchId(),
    name: plan.name,
    task: id,
    createdAt: now.toISOString(),
    deadline: plan.deadline.toISOString(),
  };
  const { cwd } = deps;
  let def: WatchDef;
  if (plan.kind === 'ci') {
    const { url, head } = await resolvePr(id, plan.pr, reportedPr(task.prs), deps);
    def = {
      ...base,
      source: {
        kind: 'ci',
        pr: url,
        required: plan.required,
        head,
        headSince: now.toISOString(),
        cwd,
        ...settingsDirOf(deps),
      },
      everyMs: CI_EVERY_MS,
    };
  } else if (plan.kind === 'command') {
    def = {
      ...base,
      source: { kind: 'command', command: plan.command, cwd, ...settingsDirOf(deps) },
      everyMs: plan.everyMs,
    };
  } else def = { ...base, source: { kind: 'timer' }, everyMs: 0 };

  if (context.dryRun) {
    context.print(`DRY store watch "${def.name}" for ${id} until ${localTime(plan.deadline)}`);
    return;
  }
  const others = deps.watches.list(id).defs.filter((open) => open.name !== def.name);
  const replaced = deps.watches.read(id, def.name) !== undefined;
  const result: AttemptResult =
    def.source.kind === 'timer'
      ? { kind: 'pending', summary: `waiting until ${localTime(plan.deadline)}` }
      : await attempt(def, now, { run: deps.run, timeLimitMs: UNIT_ATTEMPT_LIMIT_MS, registration: true });
  if (result.kind === 'broken') throw new UsageError(`cannot watch "${def.name}": ${result.reason}`);
  if (result.kind === 'event') {
    // The answer is here already: nothing to wait for, and an older watch of that name must not report later.
    deps.watches.claim(id, def.name)?.done();
    context.print(
      eventsMessage(id, [{ name: def.name, at: now.toISOString(), text: sanitizeEventText(result.text) }], others, now),
    );
    return;
  }
  const stored: WatchDef = {
    ...(result.def ?? def),
    ...(def.source.kind === 'timer' ? {} : { last: { at: now.toISOString(), summary: result.summary } }),
  };
  deps.watches.write(stored);
  confirm(context, `watching "${def.name}" on ${id}: ${result.summary}; until ${localTime(plan.deadline)}`);
  if (replaced) confirm(context, `it replaced the open watch "${def.name}"`);
  confirm(context, KEEP_WORKING);
}

function describeSource(def: WatchDef): string {
  const { source } = def;
  if (source.kind === 'timer') return 'timer';
  if (source.kind === 'ci') return `ci ${source.pr}${source.required ? ' (required checks)' : ''}`;
  return `every ${describeEvery(def.everyMs)}: ${oneLine(source.command, 80)}`;
}

function watchJson(def: WatchDef): Record<string, unknown> {
  const { source } = def;
  return {
    name: def.name,
    source:
      source.kind === 'timer'
        ? { kind: 'timer' }
        : source.kind === 'ci'
          ? { kind: 'ci', pr: source.pr, required: source.required }
          : { kind: 'command', command: source.command },
    everyMs: def.everyMs,
    createdAt: def.createdAt,
    deadline: def.deadline,
    last: def.last ?? null,
  };
}

export interface OpenWatches {
  defs: WatchDef[];
  // Events written and not yet handed to the agent.
  undelivered: number;
  unreadable: number;
}

/** The open watches of a task on this machine. */
export async function readWatches(
  context: Context,
  id: string,
  store: WatchStore,
  ownTask?: string,
): Promise<OpenWatches> {
  requireOwnTask(id, ownTask);
  await openTask(context, id, 'its watches live');
  const { defs, unreadable } = store.list(id);
  return { defs, undelivered: store.events(id).length, unreadable: unreadable.length };
}

export function watchesJson({ defs }: OpenWatches): Record<string, unknown>[] {
  return defs.map(watchJson);
}

export function formatWatches(id: string, { defs, undelivered, unreadable }: OpenWatches): string[] {
  const lines =
    defs.length === 0
      ? [`${id} has no open watch`]
      : defs.flatMap((def) => [
          `${def.name}  ${describeSource(def)}`,
          `  until ${localTime(new Date(def.deadline))}; ${
            def.last === undefined
              ? 'not looked at yet'
              : `last looked at ${localTime(new Date(def.last.at))}: ${oneLine(def.last.summary, 200)}`
          }`,
        ]);
  if (undelivered > 0) lines.push(`${undelivered} event${undelivered > 1 ? 's' : ''} not handed to the agent yet`);
  if (unreadable > 0) lines.push(`${unreadable} watch file${unreadable > 1 ? 's' : ''} could not be read`);
  return lines;
}

/** Stops a watch. It goes by claim, so an attempt in flight cannot report afterwards; no event is written. */
export async function unwatch(
  context: Context,
  id: string,
  name: string,
  deps: { watches: WatchStore; ownTask?: string },
): Promise<void> {
  requireOwnTask(id, deps.ownTask);
  await openTask(context, id, 'its watches live');
  checkedName(name);
  if (context.dryRun) {
    context.print(`DRY stop watch "${name}" on ${id}`);
    return;
  }
  const claim = deps.watches.claim(id, name);
  if (claim === undefined) {
    const open = deps.watches.list(id).defs.map((def) => `"${def.name}"`);
    throw new UsageError(
      open.length === 0 ? `${id} has no open watch` : `${id} has no watch "${name}"; open: ${open.join(', ')}`,
    );
  }
  claim.done();
  confirm(context, `stopped watch "${name}" on ${id}`);
}
