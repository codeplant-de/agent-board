// `board schedule [--priority p] [--title t] [--hold] [--new] <prompt...>`: a task from a prompt, written as you would
// type it into Claude Code, bound to this machine and the directory it was scheduled from. Before it creates one, a
// quick Haiku call checks whether an open task already covers it.
import { execFile } from 'node:child_process';
import { isPriority, isRecord, PRIORITIES } from '@agent-board/shared';
import type { Backend, Priority, Task } from '@agent-board/shared';
import { UsageError } from './cli.mts';

export const SCHEDULE_USAGE = 'usage: board schedule [--priority <p>] [--title <t>] [--hold] [--new] <prompt...>';

export interface ScheduleArgs {
  prompt: string;
  priority: Priority | undefined;
  title: string | undefined;
  // Waits in Needs me instead of Todo.
  hold: boolean;
  // Skips the duplicate check.
  forceNew: boolean;
}

// The board's flags come first; everything from the first other word on is the prompt, flags included (`--auto`).
export function parseScheduleArgs(args: string[]): ScheduleArgs {
  const result: ScheduleArgs = { prompt: '', priority: undefined, title: undefined, hold: false, forceNew: false };
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      index++;
      break;
    }
    if (arg === '--hold') result.hold = true;
    else if (arg === '--new') result.forceNew = true;
    else if (arg === '--priority' || arg === '--title') {
      const value = args[++index];
      if (value === undefined) throw new UsageError(SCHEDULE_USAGE);
      if (arg === '--title') result.title = value.trim();
      else if (isPriority(value)) result.priority = value;
      else throw new UsageError(`unknown priority "${value.slice(0, 20)}"; use one of ${PRIORITIES.join(', ')}`);
    } else break;
  }
  result.prompt = args.slice(index).join(' ').trim();
  if (result.prompt === '') throw new UsageError(SCHEDULE_USAGE);
  return result;
}

export function titleOf(prompt: string): string {
  const first = prompt.split('\n')[0]?.trim() ?? '';
  return first.length > 100 ? `${first.slice(0, 99)}…` : first;
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

export function haikuDuplicateCheck(warn: (line: string) => void): DuplicateCheck {
  return async (prompt, workdir, open) => {
    if (open.length === 0) return undefined;
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
  print: (line: string) => void;
  check: DuplicateCheck;
  // Asks in the terminal; undefined when there is none (a script), which creates the task with a warning.
  choose: ((duplicate: Duplicate, task: Task) => Promise<Choice>) | undefined;
}

export async function schedule(deps: ScheduleDeps, args: ScheduleArgs): Promise<Task | undefined> {
  const { backend } = deps;
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
        if (existing.status === 'todo' || existing.status === 'running') {
          deps.print(`${existing.id} is already ${existing.status === 'todo' ? 'queued' : 'running'}: ${existing.url}`);
          return existing;
        }
        const requeued = await backend.updateTask(existing.id, {
          status: args.hold ? 'needs-me' : 'todo',
          next: 'fresh',
        });
        await backend.addNote(existing.id, `Scheduled again from ${deps.machine}:${deps.workdir}.`, {
          author: 'system',
        });
        deps.print(`requeued ${requeued.id} ${requeued.url}`);
        return requeued;
      }
      if (!deps.choose) warning = `Possibly a duplicate of ${existing.id} ("${existing.title}"): ${duplicate.reason}`;
    }
  }
  const { task } = await backend.addTask({
    title: args.title || titleOf(args.prompt),
    input: args.prompt,
    labels: [],
    status: args.hold ? 'needs-me' : 'todo',
    createdBy: 'user',
    machine: deps.machine,
    workdir: deps.workdir,
    ...(args.priority ? { priority: args.priority } : {}),
  });
  if (warning) await backend.addNote(task.id, warning, { author: 'system' });
  deps.print(`scheduled ${task.id} ${task.url}`);
  return task;
}
