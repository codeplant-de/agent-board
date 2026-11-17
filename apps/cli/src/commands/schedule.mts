// `board schedule [--priority p] [--model m] [--agent a] [--title t] [--hold | --backlog] [--in <dur> | --at <time>] [--every <dur> | --cron <expr>]
// [--times <n> | --until <time>] [--polish] [--new] [--key <k> [--version <v>]] <prompt...>`: a task from a prompt, written as you
// would type it into Claude Code, bound to this machine and the directory it was scheduled from. Before it creates one, a quick
// Haiku call checks whether an open task already covers it. With `--every` or `--cron` it creates a repeating schedule instead.
// With `--polish` the task goes to Backlog and a child task that polishes its prompt is queued, as the board's "Polish prompt"
// button does. With `--key` the board itself dedupes by the key, and `--version` requeues the task when the version moved:
// what a script that runs `board schedule` again and again needs.
import { execFile } from 'node:child_process';
import {
  AGENT_NAME_RULE,
  ContractError,
  defaultTitle,
  describeRule,
  isAgentName,
  isModelName,
  isPriority,
  isRecord,
  MODEL_ALIASES,
  parseDuration,
  parseWhen,
  polishTask,
  PRIORITIES,
} from '@agent-board/shared';
import type { Command } from 'commander';
import type { Backend, DraftStatus, Priority, Task } from '@agent-board/shared';
import { UsageError } from '../cli.mts';
import { BackendError } from '../backend/backend.mts';
import { plainLine } from '../output/terminal.mts';

export interface ScheduleArgs {
  prompt: string;
  priority: Priority | undefined;
  // The Claude model of the run; undefined is claude's default.
  model: string | undefined;
  // The agent of this machine's config.json the task runs as; undefined runs it by its creator's rules.
  agent: string | undefined;
  title: string | undefined;
  // Waits in Needs me instead of Todo.
  hold: boolean;
  // Parked in Backlog instead of Todo.
  backlog: boolean;
  // Waits in Todo until then (`--in`, `--at`); with a repeat, the first run.
  notBefore: Date | undefined;
  // A repeat: the interval in ms (`--every`) or a 5-field cron expression (`--cron`), ending after `times` runs or at `until`.
  every: number | undefined;
  cron: string | undefined;
  times: number | undefined;
  until: Date | undefined;
  // Skips the duplicate check.
  forceNew: boolean;
  // Parks it in Backlog and queues a task that polishes its prompt.
  polish: boolean;
  // The board creates one task per key; asking again finds it. `version` is what the task was made for (a PR's head sha).
  key: string | undefined;
  version: string | undefined;
}

// The flags `board schedule` takes before the prompt, as commander hands them over.
export interface ScheduleFlags {
  priority?: string;
  model?: string;
  agent?: string;
  title?: string;
  hold?: boolean;
  backlog?: boolean;
  new?: boolean;
  polish?: boolean;
  in?: string;
  at?: string;
  every?: string;
  cron?: string;
  times?: string;
  until?: string;
  key?: string;
  version?: string;
}

const KEY_MAX = 500;
const VERSION_MAX = 200;

export function addScheduleOptions(command: Command): Command {
  return command
    .option('--priority <priority>', `${PRIORITIES.join(', ')} (default normal)`)
    .option(
      '--model <model>',
      `claude model alias or full name, e.g. ${MODEL_ALIASES.map((alias) => alias.value).join(', ')} (default: claude's default)`,
    )
    .option(
      '--agent <name>',
      "run the task as this agent of this machine's config.json (its tools and lists only, never asking); the board keeps the name sealed",
    )
    .option('--title <title>', "the task's title (default: the prompt's first line)")
    .option('--hold', 'land it in needs-me instead of Todo')
    .option('--backlog', 'park it in backlog instead of Todo')
    .option('--in <duration>', 'keep it in Todo for this long (30m, 2h, 1d, 1h30m); with a repeat, the first run')
    .option(
      '--at <time>',
      'keep it in Todo until then (2027-01-01T12:00, 2027-01-01, 09:30); with a repeat, the first run',
    )
    .option('--every <duration>', 'repeat on a fixed grid from the first run (2h)')
    .option('--cron <expr>', 'repeat by a 5-field cron expression in this machine\'s time zone ("0 9 * * 1-5")')
    .option('--times <n>', 'end a repeat after this many runs, the first included')
    .option('--until <time>', 'end a repeat after this time')
    .option('--polish', 'park it in backlog and queue a task that polishes its prompt, as "Polish prompt" on the board')
    .option('--new', 'skip the duplicate check')
    .option(
      '--key <key>',
      'one task per key on the board: a second schedule with the same key finds the first instead of making another, with no duplicate check',
    )
    .option(
      '--version <version>',
      'with --key: what the task was made for (a PR head sha); a task in needs-me or done goes back to Todo when it differs',
    );
}

// The flags are the board's own; the words after them are the prompt, flags included (`--auto`).
export function parseScheduleArgs(flags: ScheduleFlags, words: string[], now: Date = new Date()): ScheduleArgs {
  const hold = flags.hold === true;
  const polish = flags.polish === true;
  // A polished prompt can only be applied to a Backlog task.
  const backlog = flags.backlog === true || polish;
  const { in: delay, at, every, times, until } = flags;
  const cron = flags.cron?.trim();
  if (polish) {
    const conflicts = [
      hold && '--hold',
      delay !== undefined && '--in',
      at !== undefined && '--at',
      every !== undefined && '--every',
      flags.cron !== undefined && '--cron',
      times !== undefined && '--times',
      until !== undefined && '--until',
    ].filter((flag) => flag !== false);
    if (conflicts.length > 0)
      throw new UsageError(
        `--polish parks the task in Backlog, where its polished prompt is applied; it cannot be combined with ${conflicts.join(', ')}`,
      );
  }
  const result: ScheduleArgs = {
    prompt: '',
    priority: undefined,
    model: undefined,
    agent: undefined,
    title: flags.title?.trim(),
    hold,
    backlog,
    notBefore: undefined,
    every: undefined,
    cron,
    times: undefined,
    until: undefined,
    forceNew: flags.new === true,
    polish,
    key: undefined,
    version: undefined,
  };
  if (flags.priority !== undefined) {
    if (!isPriority(flags.priority))
      throw new UsageError(`unknown priority "${flags.priority.slice(0, 20)}"; use one of ${PRIORITIES.join(', ')}`);
    result.priority = flags.priority;
  }
  if (flags.model !== undefined) {
    if (!isModelName(flags.model))
      throw new UsageError(
        `"${flags.model.slice(0, 70)}" is not a model name (a claude alias such as opus, or a full name such as claude-opus-5-5)`,
      );
    result.model = flags.model;
  }
  if (flags.agent !== undefined) {
    if (!isAgentName(flags.agent))
      throw new UsageError(`"${flags.agent.slice(0, 40)}" is not an agent name (${AGENT_NAME_RULE})`);
    result.agent = flags.agent;
  }
  if (hold && backlog) throw new UsageError('--hold and --backlog cannot be combined');
  if (delay !== undefined && at !== undefined) throw new UsageError('--in and --at cannot be combined');
  if ((delay !== undefined || at !== undefined) && (hold || backlog))
    throw new UsageError('--in and --at queue the task in Todo; they cannot be combined with --hold or --backlog');
  if (every !== undefined && cron !== undefined) throw new UsageError('--every and --cron cannot be combined');
  const repeats = every !== undefined || cron !== undefined;
  if (!repeats && (times !== undefined || until !== undefined))
    throw new UsageError('--times and --until end a repeat; add --every or --cron');
  if (repeats && (hold || backlog))
    throw new UsageError('--every and --cron queue tasks in Todo; they cannot be combined with --hold or --backlog');
  if (times !== undefined && until !== undefined) throw new UsageError('--times and --until cannot be combined');
  result.notBefore = parseStart({ delay, at }, now);
  if (every !== undefined) result.every = parseInterval(every);
  if (cron !== undefined && cron.split(/\s+/).length !== 5)
    throw new UsageError(
      `--cron takes 5 fields (minute hour day month weekday), such as "0 9 * * 1-5"; got "${cron.slice(0, 60)}"`,
    );
  if (times !== undefined) {
    if (!/^[1-9]\d{0,5}$/.test(times))
      throw new UsageError(`--times takes a positive whole number; got "${times.slice(0, 20)}"`);
    result.times = Number(times);
  }
  result.until = parseStart({ at: until }, now);
  if (result.until !== undefined && result.until.getTime() < (result.notBefore ?? now).getTime())
    throw new UsageError('--until is before the first run');
  parseKeyFlags(flags, result, { hold, backlog, delayed: delay !== undefined || at !== undefined });
  result.prompt = words.join(' ').trim();
  if (result.prompt === '') throw new UsageError('a prompt is required');
  return result;
}

function checkedText(flag: string, value: string, max: number): string {
  if (value.trim() === '') throw new UsageError(`${flag} must not be empty`);
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value)) throw new UsageError(`${flag} must not contain control characters`);
  if (value.length > max) throw new UsageError(`${flag} is longer than ${max} characters`);
  return value;
}

// `--key` and `--version`: the key is used as given, so the same text from any machine finds the same task.
function parseKeyFlags(
  flags: ScheduleFlags,
  result: ScheduleArgs,
  other: { hold: boolean; backlog: boolean; delayed: boolean },
): void {
  if (flags.key === undefined) {
    if (flags.version !== undefined) throw new UsageError('--version belongs to --key: add --key');
    return;
  }
  const conflicts = [
    result.every !== undefined && '--every',
    result.cron !== undefined && '--cron',
    result.polish && '--polish',
    other.hold && '--hold',
    other.backlog && '--backlog',
    other.delayed && '--in/--at',
  ].filter((flag) => flag !== false);
  if (conflicts.length > 0)
    throw new UsageError(
      `--key makes or finds one task in Todo, and requeues it into Todo; it cannot be combined with ${conflicts.join(', ')}`,
    );
  result.key = checkedText('--key', flags.key, KEY_MAX);
  if (flags.version !== undefined) result.version = checkedText('--version', flags.version, VERSION_MAX);
}

// The time a delayed task starts, from `--in` or `--at`; undefined when neither is given.
export function parseStart(
  flags: { delay?: string | undefined; at?: string | undefined },
  now: Date,
): Date | undefined {
  try {
    if (flags.delay !== undefined) return new Date(now.getTime() + parseDuration(flags.delay));
    return flags.at === undefined ? undefined : parseWhen(flags.at, now);
  } catch (error) {
    if (error instanceof ContractError) throw new UsageError(error.message);
    throw error;
  }
}

function parseInterval(text: string): number {
  try {
    return parseDuration(text);
  } catch (error) {
    if (error instanceof ContractError) throw new UsageError(error.message);
    throw error;
  }
}

function startStatus(args: Pick<ScheduleArgs, 'hold' | 'backlog'>): DraftStatus {
  if (args.hold) return 'needs-me';
  return args.backlog ? 'backlog' : 'todo';
}

// 2027-01-01 12:00 in the caller's time zone.
export function localTime(date: Date): string {
  return date.toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
}

export interface Duplicate {
  taskId: string;
  reason: string;
}

// Asks whether an open task already covers the prompt; undefined when none does, or when the check could not run.
export type DuplicateCheck = (prompt: string, workdir: string, open: Task[]) => Promise<Duplicate | undefined>;

const DUPLICATE_SCHEMA = {
  type: 'object',
  properties: { duplicate: { type: 'boolean' }, taskId: { type: ['string', 'null'] }, reason: { type: 'string' } },
  required: ['duplicate', 'taskId', 'reason'],
};

export function duplicateQuestion(prompt: string, workdir: string, open: Task[]): string {
  const tasks = open.map((task) => ({
    id: task.id,
    title: task.title,
    prompt: task.input.slice(0, 600),
    status: task.status,
    directory: task.workdir,
  }));
  return [
    'A user is about to schedule a task for a coding agent. Decide whether one of the open tasks already covers the same work,',
    'so that scheduling it again would duplicate it. Same PR, same story, or the same question in other words counts; related',
    'but different work does not. Answer duplicate=false when unsure.',
    '',
    `New task, scheduled in ${workdir}:`,
    prompt,
    '',
    'Open tasks:',
    JSON.stringify(tasks, null, 1),
  ].join('\n');
}

export function parseDuplicateAnswer(stdout: string, open: Task[]): Duplicate | undefined {
  const outer: unknown = JSON.parse(stdout);
  const answer = isRecord(outer) ? outer['structured_output'] : undefined;
  if (!isRecord(answer) || answer['duplicate'] !== true || typeof answer['taskId'] !== 'string') return undefined;
  const taskId = answer['taskId'];
  // Only a task that is really open; the model may name something else.
  if (!open.some((task) => task.id === taskId)) return undefined;
  return { taskId, reason: typeof answer['reason'] === 'string' ? answer['reason'] : '' };
}

// `announce` tells the person waiting that the check is running; it is not called when there is nothing to compare with.
export function haikuDuplicateCheck(warn: (line: string) => void, announce?: (line: string) => void): DuplicateCheck {
  return async (prompt, workdir, open) => {
    if (open.length === 0) return undefined;
    announce?.('checking for duplicates…');
    const args = [
      '-p',
      '--model',
      'haiku',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(DUPLICATE_SCHEMA),
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      'user',
    ];
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          'claude',
          args,
          { timeout: 60_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
          (error, out) => (error ? reject(error) : resolve(out)),
        );
        child.stdin?.end(duplicateQuestion(prompt, workdir, open));
      });
      return parseDuplicateAnswer(stdout, open);
    } catch (error) {
      warn(`duplicate check skipped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      return undefined;
    }
  };
}

export type Choice = 'requeue' | 'new' | 'abort';

export interface ScheduleDeps {
  backend: Backend;
  machine: string;
  workdir: string;
  // The IANA zone a cron expression is read in.
  timezone: string;
  print: (line: string) => void;
  // Where the line that confirms a write goes; unset means print. A dry run confirms nothing.
  confirm?: (line: string) => void;
  // The link to a task, built from this machine's own board URL.
  link: (taskId: string) => string;
  check: DuplicateCheck;
  // Asks in the terminal; undefined when there is none (a script), which creates the task with a warning.
  choose: ((duplicate: Duplicate, task: Task) => Promise<Choice>) | undefined;
}

// A recurring prompt resembles its own earlier runs, so a repeat skips the duplicate check.
async function scheduleRepeat(deps: ScheduleDeps, args: ScheduleArgs): Promise<Task> {
  const { schedule, task } = await deps.backend.addSchedule({
    title: args.title || defaultTitle(args.prompt),
    input: args.prompt,
    machine: deps.machine,
    workdir: deps.workdir,
    ...(args.priority ? { priority: args.priority } : {}),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.agent === undefined ? {} : { agent: args.agent }),
    ...(args.every !== undefined ? { everyMs: args.every } : { cron: args.cron ?? '', timezone: deps.timezone }),
    ...(args.notBefore ? { startAt: args.notBefore } : {}),
    ...(args.times ? { times: args.times } : {}),
    ...(args.until ? { until: args.until } : {}),
  });
  const end = args.times ? `, ${args.times} runs` : args.until ? `, until ${localTime(args.until)}` : '';
  (deps.confirm ?? deps.print)(
    `scheduled repeat ${schedule.id}: ${describeRule(schedule)}${end}; first run ${localTime(task.notBefore ?? new Date())} ${deps.link(task.id)}`,
  );
  return task;
}

// Why `--key` found a task and left it as it is.
export type ExistsReason = 'closed' | 'same-version' | 'no-version' | 'busy' | 'other-agent' | 'changed';

export type KeyedOutcome = { result: 'created' | 'requeued' } | { result: 'exists'; reason: ExistsReason };

export interface Scheduled {
  task: Task;
  // With `--key`: what became of the task.
  keyed?: KeyedOutcome;
  // The task that polishes `task`'s prompt (`--polish`).
  polish?: Task;
}

// A task that waits for the user, or finished, goes back to Todo for a new version; one in any other status is busy with the old.
const REQUEUEABLE: readonly Task['status'][] = ['needs-me', 'done'];

// Finds or creates the task of the key; a new version requeues one that waits in Needs me or is Done.
async function scheduleKeyed(deps: ScheduleDeps, args: ScheduleArgs, key: string): Promise<Scheduled> {
  const { backend } = deps;
  const { task, created } = await backend.addTask({
    title: args.title || defaultTitle(args.prompt),
    input: args.prompt,
    status: 'todo',
    dedupeKey: key,
    createdBy: 'user',
    machine: deps.machine,
    workdir: deps.workdir,
    ...(args.priority ? { priority: args.priority } : {}),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.agent === undefined ? {} : { agent: args.agent }),
    ...(args.version === undefined ? {} : { head: args.version }),
  });
  const say = (verb: string, shown: Task, reason?: ExistsReason): void =>
    (deps.confirm ?? deps.print)(`${verb} ${shown.id} ${deps.link(shown.id)}${reason ? ` (${reason})` : ''}`);
  const exists = (shown: Task, reason: ExistsReason): Scheduled => {
    say('exists', shown, reason);
    return { task: shown, keyed: { result: 'exists', reason } };
  };
  if (created) {
    say('created', task);
    return { task, keyed: { result: 'created' } };
  }
  if (task.closed) return exists(task, 'closed');
  if (args.version === undefined) return exists(task, 'no-version');
  if (task.head !== null && task.head === (await backend.indexHead(args.version))) return exists(task, 'same-version');
  if (!REQUEUEABLE.includes(task.status)) return exists(task, 'busy');
  // The agent is written once; a task of another agent (or none) would run the new version under the wrong rules.
  if (task.unreadable.includes('agent') || (task.agent ?? null) !== (args.agent ?? null))
    return exists(task, 'other-agent');
  let requeued: Task;
  try {
    // One atomic update, and only if the task is still as it was read: a head changed without the move would leave it behind.
    requeued = await backend.updateTask(task.id, {
      status: 'todo',
      head: args.version,
      next: 'fresh',
      expect: task.status,
    });
  } catch (error) {
    if (error instanceof BackendError && error.status === 409) return exists(task, 'changed');
    throw error;
  }
  await backend.addNote(task.id, `New version ${args.version}. Queued again.`, { author: 'system' });
  say('requeued', requeued);
  return { task: requeued, keyed: { result: 'requeued' } };
}

export async function schedule(deps: ScheduleDeps, args: ScheduleArgs): Promise<Scheduled | undefined> {
  const { backend } = deps;
  if (args.key !== undefined) return scheduleKeyed(deps, args, args.key);
  if (args.every !== undefined || args.cron !== undefined) return { task: await scheduleRepeat(deps, args) };
  let warning: string | undefined;
  if (!args.forceNew) {
    // A task this machine cannot read says nothing to the check, and the model must not see its placeholder.
    // A task that runs as another agent (or as none) is not the same work, so it is never a duplicate of this one.
    const open = (await backend.listTasks()).filter(
      (task) =>
        task.status !== 'done' &&
        task.unreadable.every((field) => field === 'watches') &&
        (task.agent ?? null) === (args.agent ?? null),
    );
    const duplicate = await deps.check(args.prompt, deps.workdir, open);
    const existing = duplicate === undefined ? undefined : open.find((task) => task.id === duplicate.taskId);
    if (duplicate && existing) {
      deps.print(
        `Looks like ${existing.id} (${existing.status}) "${plainLine(existing.title)}" covers this: ${plainLine(duplicate.reason)}`,
      );
      const choice = deps.choose ? await deps.choose(duplicate, existing) : 'new';
      if (choice === 'abort') {
        deps.print('nothing scheduled');
        return undefined;
      }
      if (choice === 'requeue') {
        // The existing task's prompt is not the one just typed; polishing it stays a click on the board.
        if (args.polish) deps.print(`no polish queued for ${existing.id}; queue one with "Polish prompt" on the board`);
        if (args.model !== undefined && args.model !== existing.model)
          deps.print(
            `${existing.id} keeps its model (${existing.model ?? 'the default'}); --model applies only to a new task`,
          );
        if (existing.status === 'todo' && args.notBefore) {
          const delayed = await backend.updateTask(existing.id, { notBefore: args.notBefore, expect: 'todo' });
          (deps.confirm ?? deps.print)(
            `${existing.id} is already queued, now starts ${localTime(args.notBefore)}: ${deps.link(delayed.id)}`,
          );
          return { task: delayed };
        }
        if (existing.status === 'todo' || existing.status === 'running') {
          const note = args.notBefore ? '; the start time was not applied' : '';
          (deps.confirm ?? deps.print)(
            `${existing.id} is already ${existing.status === 'todo' ? 'queued' : 'running'}${note}: ${deps.link(existing.id)}`,
          );
          return { task: existing };
        }
        const requeued = await backend.updateTask(existing.id, {
          status: startStatus(args),
          next: 'fresh',
          ...(args.notBefore ? { notBefore: args.notBefore } : {}),
        });
        await backend.addNote(existing.id, `Scheduled again from ${deps.machine}:${deps.workdir}.`, {
          author: 'system',
        });
        (deps.confirm ?? deps.print)(
          `requeued ${requeued.id} ${deps.link(requeued.id)}${requeued.notBefore ? `, starts ${localTime(requeued.notBefore)}` : ''}`,
        );
        return { task: requeued };
      }
      if (!deps.choose) warning = `Possibly a duplicate of ${existing.id} ("${existing.title}"): ${duplicate.reason}`;
    }
  }
  const { task } = await backend.addTask({
    title: args.title || defaultTitle(args.prompt),
    input: args.prompt,
    status: startStatus(args),
    ...(args.notBefore ? { notBefore: args.notBefore } : {}),
    createdBy: 'user',
    machine: deps.machine,
    workdir: deps.workdir,
    ...(args.priority ? { priority: args.priority } : {}),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.agent === undefined ? {} : { agent: args.agent }),
  });
  if (warning) await backend.addNote(task.id, warning, { author: 'system' });
  (deps.confirm ?? deps.print)(
    `scheduled ${task.id} ${deps.link(task.id)}${task.notBefore ? `, starts ${localTime(task.notBefore)}` : ''}`,
  );
  if (!args.polish) return { task };
  const { place, ...draft } = polishTask(task);
  const { task: polish } = await backend.addTask({
    ...draft,
    createdBy: 'user',
    ...(place ? { machine: place.machine, workdir: place.workdir } : {}),
  });
  (deps.confirm ?? deps.print)(`queued polish ${polish.id} ${deps.link(polish.id)}`);
  return { task, polish };
}
