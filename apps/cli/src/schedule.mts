// `board schedule [--priority p] [--title t] [--hold | --backlog] [--in <dur> | --at <time>] [--every <dur> | --cron <expr>]
// [--times <n> | --until <time>] [--new] <prompt...>`: a task from a prompt, written as you would type it into Claude Code,
// bound to this machine and the directory it was scheduled from. Before it creates one, a quick Haiku call checks whether
// an open task already covers it. With `--every` or `--cron` it creates a repeating schedule instead.
import { execFile } from 'node:child_process';
import {
  ContractError,
  defaultTitle,
  describeRule,
  isPriority,
  isRecord,
  parseDuration,
  parseWhen,
  PRIORITIES,
} from '@agent-board/shared';
import type { Command } from 'commander';
import type { Backend, Priority, Status, Task } from '@agent-board/shared';
import { UsageError } from './cli.mts';

export interface ScheduleArgs {
  prompt: string;
  priority: Priority | undefined;
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
}

// The flags `board schedule` takes before the prompt, as commander hands them over.
export interface ScheduleFlags {
  priority?: string;
  title?: string;
  hold?: boolean;
  backlog?: boolean;
  new?: boolean;
  in?: string;
  at?: string;
  every?: string;
  cron?: string;
  times?: string;
  until?: string;
}

export function addScheduleOptions(command: Command): Command {
  return command
    .option('--priority <priority>', `${PRIORITIES.join(', ')} (default normal)`)
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
    .option('--new', 'skip the duplicate check');
}

// The flags are the board's own; the words after them are the prompt, flags included (`--auto`).
export function parseScheduleArgs(flags: ScheduleFlags, words: string[], now: Date = new Date()): ScheduleArgs {
  const hold = flags.hold === true;
  const backlog = flags.backlog === true;
  const { in: delay, at, every, times, until } = flags;
  const cron = flags.cron?.trim();
  const result: ScheduleArgs = {
    prompt: '',
    priority: undefined,
    title: flags.title?.trim(),
    hold,
    backlog,
    notBefore: undefined,
    every: undefined,
    cron,
    times: undefined,
    until: undefined,
    forceNew: flags.new === true,
  };
  if (flags.priority !== undefined) {
    if (!isPriority(flags.priority))
      throw new UsageError(`unknown priority "${flags.priority.slice(0, 20)}"; use one of ${PRIORITIES.join(', ')}`);
    result.priority = flags.priority;
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
  result.prompt = words.join(' ').trim();
  if (result.prompt === '') throw new UsageError('a prompt is required');
  return result;
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

function startStatus(args: Pick<ScheduleArgs, 'hold' | 'backlog'>): Status {
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
    ...(args.every !== undefined ? { everyMs: args.every } : { cron: args.cron ?? '', timezone: deps.timezone }),
    ...(args.notBefore ? { startAt: args.notBefore } : {}),
    ...(args.times ? { times: args.times } : {}),
    ...(args.until ? { until: args.until } : {}),
  });
  const end = args.times ? `, ${args.times} runs` : args.until ? `, until ${localTime(args.until)}` : '';
  (deps.confirm ?? deps.print)(
    `scheduled repeat ${schedule.id}: ${describeRule(schedule)}${end}; first run ${localTime(task.notBefore ?? new Date())} ${task.url}`,
  );
  return task;
}

export async function schedule(deps: ScheduleDeps, args: ScheduleArgs): Promise<Task | undefined> {
  const { backend } = deps;
  if (args.every !== undefined || args.cron !== undefined) return scheduleRepeat(deps, args);
  let warning: string | undefined;
  if (!args.forceNew) {
    const open = (await backend.listTasks()).filter((task) => task.status !== 'done');
    const duplicate = await deps.check(args.prompt, deps.workdir, open);
    const existing = duplicate === undefined ? undefined : open.find((task) => task.id === duplicate.taskId);
    if (duplicate && existing) {
      deps.print(`Looks like ${existing.id} (${existing.status}) "${existing.title}" covers this: ${duplicate.reason}`);
      const choice = deps.choose ? await deps.choose(duplicate, existing) : 'new';
      if (choice === 'abort') {
        deps.print('nothing scheduled');
        return undefined;
      }
      if (choice === 'requeue') {
        if (existing.status === 'todo' && args.notBefore) {
          const delayed = await backend.updateTask(existing.id, { notBefore: args.notBefore, expect: 'todo' });
          (deps.confirm ?? deps.print)(
            `${existing.id} is already queued, now starts ${localTime(args.notBefore)}: ${delayed.url}`,
          );
          return delayed;
        }
        if (existing.status === 'todo' || existing.status === 'running') {
          const note = args.notBefore ? '; the start time was not applied' : '';
          (deps.confirm ?? deps.print)(
            `${existing.id} is already ${existing.status === 'todo' ? 'queued' : 'running'}${note}: ${existing.url}`,
          );
          return existing;
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
          `requeued ${requeued.id} ${requeued.url}${requeued.notBefore ? `, starts ${localTime(requeued.notBefore)}` : ''}`,
        );
        return requeued;
      }
      if (!deps.choose) warning = `Possibly a duplicate of ${existing.id} ("${existing.title}"): ${duplicate.reason}`;
    }
  }
  const { task } = await backend.addTask({
    title: args.title || defaultTitle(args.prompt),
    input: args.prompt,
    labels: [],
    status: startStatus(args),
    ...(args.notBefore ? { notBefore: args.notBefore } : {}),
    createdBy: 'user',
    machine: deps.machine,
    workdir: deps.workdir,
    ...(args.priority ? { priority: args.priority } : {}),
  });
  if (warning) await backend.addNote(task.id, warning, { author: 'system' });
  (deps.confirm ?? deps.print)(
    `scheduled ${task.id} ${task.url}${task.notBefore ? `, starts ${localTime(task.notBefore)}` : ''}`,
  );
  return task;
}
