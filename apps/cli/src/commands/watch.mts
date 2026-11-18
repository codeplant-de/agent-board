// `board watch`, `board watches` and `board unwatch`: the commands over the watches of a task on this machine (see watch/store.mts).
import { ContractError, formatDuration, isRecord, MAX_WAIT_MS, parseDuration } from '@agent-board/shared';
import type { Task, TaskPr } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import type { Context } from '../cli.mts';
import { oneLine, shellQuote } from '../output/text.mts';
import { attempt, countEvents, UNIT_ATTEMPT_LIMIT_MS } from '../watch/attempt.mts';
import type { AttemptResult, WatchRunner } from '../watch/attempt.mts';
import { deadlineTime, describeEvery, eventsMessage, sanitizeEventText } from '../watch/fence.mts';
import {
  CI_EVERY_MS,
  MAX_COMMAND_CHARS,
  MIN_COMMAND_EVERY_MS,
  newWatchId,
  PR_MERGED_EVERY_MS,
  PR_REVIEW_EVERY_MS,
  PR_REVIEW_TIMEOUT_MS,
} from '../watch/store.mts';
import type { WatchDef, WatchStore } from '../watch/store.mts';
import { publishWatches } from '../watch/publish.mts';
import {
  isGhLogin,
  isIgnorePattern,
  isPrUrl,
  isWatchName,
  MAX_IGNORE_CHARS,
  MAX_IGNORE_PATTERNS,
} from '../watch/shapes.mts';
import { dirCiIgnore } from '../config/dirs.mts';
import { isUnitRunning } from '../watch/tick.mts';
import { confirm } from './board.mts';
import { localTime, parseStart } from './schedule.mts';

export interface WatchFlags {
  // `--ci` alone is true; `--ci <pr>` carries the PR.
  ci?: string | true;
  // `--pr-review` alone is true; `--pr-review <pr>` carries the PR.
  prReview?: string | true;
  // `--pr-merged` alone is true; `--pr-merged <pr>` carries the PR.
  prMerged?: string | true;
  required?: boolean;
  // `--ignore`, repeated.
  ignore?: string[];
  name?: string;
  // With a command: keep it running and report its output lines.
  stream?: boolean;
  every?: string;
  timeout?: string;
  in?: string;
  at?: string;
}

export const DEFAULT_WATCH_EVERY = '30s';
export const DEFAULT_WATCH_TIMEOUT = '2h';
export const DEFAULT_REVIEW_TIMEOUT = formatDuration(PR_REVIEW_TIMEOUT_MS);
// A merge waits for people, so a watch for it looks as long as a watch may.
export const DEFAULT_PR_MERGED_TIMEOUT = '7d';
export const KEEP_WORKING =
  'Keep working if there is work; end your turn when there is none: the task waits and resumes with the event.';

const PR_NUMBER = /^[1-9]\d{0,8}$/;
const PR_RESOLVE_LIMIT_MS = 60_000;

export type WatchPlan = {
  name: string;
  deadline: Date;
} & (
  | { kind: 'ci'; pr: string | undefined; required: boolean; ignore: string[] }
  | { kind: 'pr-review'; pr: string | undefined }
  | { kind: 'pr-merged'; pr: string | undefined }
  | { kind: 'command'; command: string; everyMs: number }
  | { kind: 'stream'; command: string }
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

/** The `--ignore` patterns and the covering directory's `ciIgnore`, flags first, without duplicates; refused above the cap. */
export function mergedIgnore(flags: string[], configured: string[]): { ignore: string[]; fromConfig: string[] } {
  const ignore = [...new Set([...flags, ...configured])];
  if (ignore.length > MAX_IGNORE_PATTERNS)
    throw new UsageError(
      `--ignore and the ciIgnore of the dirs config make ${ignore.length} patterns, more than the ${MAX_IGNORE_PATTERNS} a watch takes; give fewer --ignore or shorten the dir's ciIgnore`,
    );
  return { ignore, fromConfig: configured.filter((pattern) => !flags.includes(pattern)) };
}

function checkedIgnore(patterns: string[]): string[] {
  if (patterns.length > MAX_IGNORE_PATTERNS)
    throw new UsageError(`--ignore may be given at most ${MAX_IGNORE_PATTERNS} times`);
  for (const pattern of patterns)
    if (!isIgnorePattern(pattern))
      throw new UsageError(
        `--ignore takes a check name, with * for any characters: 1-${MAX_IGNORE_CHARS} characters, no control characters; got "${oneLine(pattern, 40)}"`,
      );
  return [...new Set(patterns)];
}

/**
 * What the flags and the words after `--` ask for. Exactly one source: `--ci`, `--pr-review`, `--pr-merged`, a command, or `--in`/`--at`. Reads nothing: the
 * task and the PR are looked at afterwards.
 */
export function parseWatchFlags(flags: WatchFlags, words: string[], now: Date = new Date()): WatchPlan {
  const { ci, prReview, prMerged, required, ignore, name, stream, every, timeout, in: inText, at } = flags;
  if (inText !== undefined && at !== undefined) throw new UsageError('give --in or --at, not both');
  if (stream === true && words.length === 0) throw new UsageError('--stream goes with a command after --');
  if (stream === true && every !== undefined)
    throw new UsageError(
      'give --stream or --every, not both: a stream runs its command once and reports what it prints',
    );
  const sources = [
    ci !== undefined,
    prReview !== undefined,
    prMerged !== undefined,
    words.length > 0,
    inText !== undefined || at !== undefined,
  ].filter(Boolean).length;
  if (sources !== 1)
    throw new UsageError(
      `give exactly one source: --ci for the CI of a PR, --pr-review for its reviews and comments, --pr-merged for its merge, a command after -- (with --name; --stream to follow its output), or --in/--at for a timer`,
    );
  if (required === true && ci === undefined) throw new UsageError('--required goes with --ci');
  if (ignore !== undefined && ci === undefined) throw new UsageError('--ignore goes with --ci');
  const timeoutMs = (fallback: string = DEFAULT_WATCH_TIMEOUT): number => {
    const ms = duration(timeout ?? fallback, '--timeout');
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
      ignore: checkedIgnore(ignore ?? []),
      deadline: new Date(now.getTime() + timeoutMs()),
    };
  }
  if (prReview !== undefined) {
    if (every !== undefined)
      throw new UsageError(
        `--every goes with a command; a review watch looks every ${describeEvery(PR_REVIEW_EVERY_MS)}`,
      );
    return {
      kind: 'pr-review',
      name: checkedName(name ?? 'review'),
      pr: prReview === true ? undefined : prReview,
      deadline: new Date(now.getTime() + timeoutMs(DEFAULT_REVIEW_TIMEOUT)),
    };
  }
  if (prMerged !== undefined) {
    if (every !== undefined)
      throw new UsageError(
        `--every goes with a command; a --pr-merged watch looks every ${describeEvery(PR_MERGED_EVERY_MS)}`,
      );
    return {
      kind: 'pr-merged',
      name: checkedName(name ?? 'pr-merged'),
      pr: prMerged === true ? undefined : prMerged,
      deadline: new Date(now.getTime() + timeoutMs(DEFAULT_PR_MERGED_TIMEOUT)),
    };
  }
  if (words.length > 0) {
    if (name === undefined) throw new UsageError('a command watch needs --name <name>: it tells the events apart');
    // One word is the shell command as written; several are the words of one command, quoted so they stay what was typed.
    const command = words.length === 1 ? (words[0] ?? '') : words.map(shellQuote).join(' ');
    if (command.trim() === '') throw new UsageError('the command after -- is empty');
    if (command.length > MAX_COMMAND_CHARS)
      throw new UsageError(`the command is longer than ${MAX_COMMAND_CHARS} characters; put it in a script`);
    if (stream === true)
      return { kind: 'stream', name: checkedName(name), command, deadline: new Date(now.getTime() + timeoutMs()) };
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
    throw new UsageError(
      '--every and --timeout go with --ci, --pr-review, --pr-merged or a command; a timer ends at its time',
    );
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

// Tells the board the task's watches after this command changed the store.
function publish(context: Context, store: WatchStore, id: string, now: Date): Promise<void> {
  return publishWatches({ store, backend: context.backend, now: () => now, log: context.print }, id);
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
  flag: '--ci' | '--pr-review' | '--pr-merged',
  given: string | undefined,
  taskPr: string | null,
  deps: WatchDeps,
): Promise<{ url: string; head: string }> {
  const arg = (given ?? taskPr)?.trim();
  if (arg === undefined || arg === '') throw new UsageError(`give the PR: board watch ${id} ${flag} <url>`);
  if (!isPrUrl(arg) && !PR_NUMBER.test(arg))
    throw new UsageError(`${flag} takes a PR URL or number; got "${oneLine(arg, 60)}"`);
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

// The login gh uses on this machine, or undefined when gh does not say: then only the PR's author is left out.
async function ghLogin(deps: WatchDeps): Promise<string | undefined> {
  const result = await deps.run({
    command: 'gh api user --jq .login',
    cwd: deps.cwd,
    timeLimitMs: PR_RESOLVE_LIMIT_MS,
    ...settingsDirOf(deps),
  });
  const login = result.stdout.trim();
  return result.exitCode === 0 && isGhLogin(login) ? login : undefined;
}

/**
 * Starts a watch on a task of this machine. A stream is stored for the watch unit, which starts its command. A ci, pr-review, pr-merged or command watch is looked at once first, in the environment the watch unit uses:
 * a command that cannot run here fails the call, and one that already has its event reports it and stores nothing. A ci watch
 * whose checks all passed is the exception: it needs a second look (see decideCi).
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
  if (plan.kind === 'command' || plan.kind === 'stream') {
    // An agent's run allows a fixed list of commands; a command watch would run any command.
    // A run an older CLI started for the removed intake has its narrow list but no AGENT_BOARD_RESTRICTED.
    if (task.createdBy === 'intake')
      throw new UsageError(
        `${id} is a task of the removed intake: it may watch with --ci, --pr-review, --pr-merged or --in/--at only`,
      );
    if (deps.restricted === true)
      throw new UsageError(
        `${id} runs as an agent with a fixed list of commands: it may watch with --ci, --pr-review, --pr-merged or --in/--at only`,
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
  // The ignore patterns of a ci watch that came from the dirs config and not from --ignore.
  let fromConfig: string[] = [];
  if (plan.kind === 'ci') {
    const { url, head } = await resolvePr(id, '--ci', plan.pr, reportedPr(task.prs), deps);
    const merged = mergedIgnore(plan.ignore, dirCiIgnore(context.config.dirs, cwd));
    fromConfig = merged.fromConfig;
    def = {
      ...base,
      source: {
        kind: 'ci',
        pr: url,
        required: plan.required,
        ...(merged.ignore.length > 0 ? { ignore: merged.ignore } : {}),
        head,
        headSince: now.toISOString(),
        cwd,
        ...settingsDirOf(deps),
      },
      everyMs: CI_EVERY_MS,
    };
  } else if (plan.kind === 'pr-review') {
    const { url } = await resolvePr(id, '--pr-review', plan.pr, reportedPr(task.prs), deps);
    const self = await ghLogin(deps);
    def = {
      ...base,
      source: { kind: 'pr-review', pr: url, ...(self === undefined ? {} : { self }), cwd, ...settingsDirOf(deps) },
      everyMs: PR_REVIEW_EVERY_MS,
    };
  } else if (plan.kind === 'pr-merged') {
    const { url } = await resolvePr(id, '--pr-merged', plan.pr, reportedPr(task.prs), deps);
    def = {
      ...base,
      source: { kind: 'pr-merged', pr: url, cwd, ...settingsDirOf(deps) },
      everyMs: PR_MERGED_EVERY_MS,
    };
  } else if (plan.kind === 'command') {
    def = {
      ...base,
      source: { kind: 'command', command: plan.command, cwd, ...settingsDirOf(deps) },
      everyMs: plan.everyMs,
    };
  } else if (plan.kind === 'stream') {
    def = {
      ...base,
      source: { kind: 'stream', command: plan.command, cwd, starts: 0, events: 0, ...settingsDirOf(deps) },
      everyMs: 0,
    };
  } else def = { ...base, source: { kind: 'timer' }, everyMs: 0 };

  if (context.dryRun) {
    context.print(`DRY store watch "${def.name}" for ${id} until ${deadlineTime(plan.deadline, now)}`);
    return;
  }
  // Only the watch unit runs a stream's command; the dispatch tick, which polls in its place, cannot.
  if (def.source.kind === 'stream' && !isUnitRunning(deps.watches, now))
    throw new UsageError(
      `cannot watch "${def.name}": a stream needs the watch unit, which is not running on this machine; run "board setup --enable", or poll with --every`,
    );
  const others = deps.watches.list(id).defs.filter((open) => open.name !== def.name);
  const replaced = deps.watches.read(id, def.name) !== undefined;
  const result: AttemptResult =
    def.source.kind === 'timer'
      ? { kind: 'pending', summary: `waiting until ${deadlineTime(plan.deadline, now)}` }
      : def.source.kind === 'stream'
        ? { kind: 'pending', summary: 'the watch unit starts the command within seconds and reports what it prints' }
        : await attempt(def, now, { run: deps.run, timeLimitMs: UNIT_ATTEMPT_LIMIT_MS, registration: true });
  if (result.kind === 'broken') throw new UsageError(`cannot watch "${def.name}": ${result.reason}`);
  if (result.kind === 'event') {
    // The answer is here already: nothing to wait for, and an older watch of that name must not report later.
    const older = deps.watches.claim(id, def.name);
    older?.done();
    context.print(
      eventsMessage(id, [{ name: def.name, at: now.toISOString(), text: sanitizeEventText(result.text) }], others, now),
    );
    if (older !== undefined) await publish(context, deps.watches, id, now);
    return;
  }
  const stored: WatchDef = {
    ...(result.def ?? def),
    ...(def.source.kind === 'timer' || def.source.kind === 'stream'
      ? {}
      : { last: { at: now.toISOString(), summary: result.summary } }),
  };
  deps.watches.write(stored);
  await publish(context, deps.watches, id, now);
  // A timer's state is its end, so the time is said once.
  const until = def.source.kind === 'timer' ? '' : `; until ${deadlineTime(plan.deadline, now)}`;
  confirm(context, `watching "${def.name}" on ${id}: ${result.summary}${until}`);
  if (def.source.kind === 'ci' && def.source.ignore !== undefined) {
    const patterns = def.source.ignore.map((pattern) => `"${pattern}"`).join(', ');
    const origin =
      fromConfig.length === 0
        ? ''
        : fromConfig.length === def.source.ignore.length
          ? ' (from the dirs config)'
          : ` (${fromConfig.map((pattern) => `"${pattern}"`).join(', ')} from the dirs config)`;
    confirm(context, `ignoring ${patterns}${origin}`);
  }
  if (replaced) confirm(context, `it replaced the open watch "${def.name}"`);
  confirm(context, KEEP_WORKING);
}

function describeIgnore(ignore: string[] | undefined): string {
  return ignore === undefined || ignore.length === 0
    ? ''
    : ` (ignoring ${ignore.map((pattern) => `"${pattern}"`).join(', ')})`;
}

function describeSource(def: WatchDef): string {
  const { source } = def;
  if (source.kind === 'timer') return 'timer';
  if (source.kind === 'ci')
    return `ci ${source.pr}${source.required ? ' (required checks)' : ''}${describeIgnore(source.ignore)}`;
  if (source.kind === 'stream') return `stream: ${oneLine(source.command, 80)}`;
  if (source.kind === 'pr-review') return `reviews and comments of ${source.pr}`;
  if (source.kind === 'pr-merged') return `merge of ${source.pr}`;
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
          ? { kind: 'ci', pr: source.pr, required: source.required, ignore: source.ignore ?? [] }
          : source.kind === 'stream'
            ? { kind: 'stream', command: source.command, starts: source.starts, events: source.events }
            : source.kind === 'pr-review'
              ? { kind: 'pr-review', pr: source.pr }
              : source.kind === 'pr-merged'
                ? { kind: 'pr-merged', pr: source.pr }
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

function lastLine(def: WatchDef): string {
  const { source, last } = def;
  if (source.kind === 'stream')
    return last === undefined || source.starts === 0
      ? 'not started yet'
      : `${countEvents(source.events)}, ${last.summary} ${localTime(new Date(last.at))}`;
  return last === undefined
    ? 'not looked at yet'
    : `last looked at ${localTime(new Date(last.at))}: ${oneLine(last.summary, 200)}`;
}

export function formatWatches(
  id: string,
  { defs, undelivered, unreadable }: OpenWatches,
  now: Date = new Date(),
): string[] {
  const lines =
    defs.length === 0
      ? [`${id} has no open watch`]
      : defs.flatMap((def) => [
          `${def.name}  ${describeSource(def)}`,
          `  until ${deadlineTime(new Date(def.deadline), now)}; ${lastLine(def)}`,
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
  await publish(context, deps.watches, id, new Date());
  confirm(context, `stopped watch "${name}" on ${id}`);
}
