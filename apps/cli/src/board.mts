import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { UsageError } from './cli.mts';
import type { Context } from './cli.mts';
import { BackendError } from './backend.mts';
import {
  formatAnswers,
  describeRule,
  formatQuestions,
  isPriority,
  isSafeTaskId,
  isStatus,
  parseQuestions,
  PRIORITIES,
  QuestionError,
  runsLeft,
  STATUSES,
} from '@agent-board/shared';
import type { Note, Priority, Schedule, Status, Task } from '@agent-board/shared';
import { postSlack, slackText } from './notify.mts';
import { haikuDuplicateCheck, localTime, parseScheduleArgs, parseStart, schedule } from './schedule.mts';
import type { Choice, ScheduleFlags } from './schedule.mts';

const NOTE_FILE_DIR = '/tmp/';
const NOTE_FILE_MAX_BYTES = 1024 * 1024;

// Long notes come from a file, so a run's allow list can keep every command simple (no heredoc, no pipe). The agent
// can write /tmp, so the file is opened without following a link and its real location is checked on the open
// descriptor: a link to a secret is refused.
export function readNoteFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new UsageError(`cannot read the note file ${path}`);
  }
  try {
    if (!readlinkSync(`/proc/self/fd/${fd}`).startsWith(NOTE_FILE_DIR))
      throw new UsageError(`the note file must be inside ${NOTE_FILE_DIR}`);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > NOTE_FILE_MAX_BYTES)
      throw new UsageError('the note file must be a regular file of at most 1 MiB');
    return readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
}

// "Needs me" and "needs-me" name the same status, so the skill can keep saying the former.
export function parseStatus(name: string): Status {
  const normalised = name.trim().toLowerCase().replaceAll(' ', '-');
  if (!isStatus(normalised)) throw new UsageError(`unknown status "${name}"; use one of ${STATUSES.join(', ')}`);
  return normalised;
}

export async function notify(context: Context, id: string, text: string): Promise<void> {
  const message = slackText(await context.backend.getTask(id), text);
  if (context.dryRun) return context.print(`DRY slack ${message.replaceAll('\n', ' | ')}`);
  await postSlack(context.config.slackWebhookFile, message);
}

export async function tasks(context: Context): Promise<void> {
  const open = await context.backend.listTasks();
  for (const status of STATUSES) {
    const inStatus = open.filter((task) => task.status === status);
    context.print(`${status} (${inStatus.length})`);
    for (const task of inStatus)
      context.print(
        `  ${task.id}  ${task.priority.padEnd(6)}  [${task.labels.join(',') || '-'}]  ${task.title}${task.notBefore ? `  (starts ${localTime(task.notBefore)})` : ''}`,
      );
  }
}

export async function ask(context: Context, id: string, path: string): Promise<void> {
  let questions;
  try {
    questions = parseQuestions(JSON.parse(readNoteFile(path)));
  } catch (error) {
    if (error instanceof SyntaxError) throw new UsageError(`the question file is not valid JSON: ${path}`);
    if (error instanceof QuestionError) throw new UsageError(`the question file: ${error.message}`);
    throw error;
  }
  await context.backend.ask(id, questions);
  // Best effort: the question is on the board either way.
  const first = questions[0];
  await notify(
    context,
    id,
    `Question: ${first?.question ?? ''}${questions.length > 1 ? ` (+${questions.length - 1} more)` : ''}`,
  ).catch((error: unknown) => {
    context.print(`WARN notify failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

export function renderThread(task: Task, notes: Note[]): string {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const lines = [
    `# ${task.title}`,
    '',
    `status: ${task.status} · priority: ${task.priority} · labels: ${task.labels.join(', ') || '-'} · ${task.url}`,
    '',
    '## Input',
    '',
    task.input.trim() || '(empty)',
    '',
    '## Thread',
  ];
  for (const note of [...notes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    lines.push('', `### ${note.author} ${note.kind} · ${note.createdAt.toISOString()}`, '');
    if (note.kind === 'question' && note.questions) lines.push(formatQuestions(note.questions));
    if (note.kind === 'answer')
      lines.push(formatAnswers(byId.get(note.questionNoteId ?? '')?.questions, note.answers ?? []));
    if (note.text.trim() !== '') lines.push(note.text.trim());
  }
  return lines.join('\n');
}

export async function show(context: Context, id: string): Promise<void> {
  const [task, notes] = await Promise.all([context.backend.getTask(id), context.backend.readNotes(id)]);
  context.print(renderThread(task, notes));
}

export interface AddFlags {
  title?: string;
  file?: string;
  parent?: string;
  priority?: string;
}

export function parseAddFlags(flags: AddFlags): {
  title: string;
  file: string;
  parent: string | undefined;
  priority: Priority | undefined;
} {
  const title = flags.title?.trim();
  const { file, parent, priority } = flags;
  if (!title) throw new UsageError('--title needs a title');
  if (!file) throw new UsageError('--file is required');
  if (parent !== undefined && !isSafeTaskId(parent)) throw new UsageError(`"${parent.slice(0, 40)}" is not a task id`);
  if (priority !== undefined && !isPriority(priority))
    throw new UsageError(`unknown priority "${priority.slice(0, 20)}"; use one of ${PRIORITIES.join(', ')}`);
  return { title, file, parent, priority };
}

// The board puts a proposal in Needs me itself, so no status is sent.
export async function add(context: Context, flags: AddFlags): Promise<void> {
  const { title, file, parent, priority } = parseAddFlags(flags);
  // An agent proposes; the user starts it. A prompt-injected run must not queue work by itself. It runs where the
  // proposing agent works, on this machine.
  const draft = {
    title,
    input: readNoteFile(file),
    labels: [],
    createdBy: 'agent' as const,
    machine: context.config.machine,
    workdir: realpathSync(process.cwd()),
    ...(parent ? { parentId: parent } : {}),
    ...(priority ? { priority } : {}),
  };
  const { task } = await context.backend.addTask(draft);
  context.print(`proposed ${task.id} ${task.url}`);
}

export async function move(context: Context, id: string, status: Status): Promise<void> {
  try {
    await context.backend.updateTask(id, { status });
  } catch (error) {
    if (error instanceof BackendError && error.status === 403)
      throw new UsageError(`${id} is a proposal: only the user can start it. Leave it in Needs me.`);
    throw error;
  }
}

export interface DelayFlags {
  in?: string;
  at?: string;
  now?: boolean;
}

// The start time to set, or null to clear it; exactly one of the three flags.
export function parseDelayFlags(flags: DelayFlags, now: Date = new Date()): Date | null {
  const { in: delayText, at, now: dueNow } = flags;
  if ([delayText, at, dueNow].filter((flag) => flag !== undefined && flag !== false).length !== 1)
    throw new UsageError('give exactly one of --in, --at or --now');
  if (dueNow) return null;
  const start = parseStart(delayText === undefined ? { at } : { delay: delayText }, now);
  if (start === undefined) throw new UsageError('give exactly one of --in, --at or --now');
  return start;
}

export async function delay(context: Context, id: string, flags: DelayFlags): Promise<void> {
  const notBefore = parseDelayFlags(flags);
  await context.backend.updateTask(id, { notBefore, expect: 'todo' });
  context.print(notBefore === null ? `${id} is due now` : `${id} starts ${localTime(notBefore)}`);
}

// A pending card with no start time is due now.
function nextRun(schedule: Schedule): string {
  if (schedule.nextRunAt) return localTime(schedule.nextRunAt);
  return schedule.occurrenceTaskId ? 'now' : '-';
}

// `  <id>  every 2h  next 2027-01-01 10:00  3 left  paused  <title>`
export function formatSchedule(schedule: Schedule): string {
  const left = runsLeft(schedule);
  const state = schedule.ended ? 'ended' : schedule.paused ? 'paused' : '-';
  return [
    schedule.id,
    describeRule(schedule),
    `next ${nextRun(schedule)}`,
    left !== null ? `${left} left` : schedule.until ? `until ${localTime(schedule.until)}` : 'forever',
    state,
    schedule.title,
  ].join('  ');
}

export async function schedules(context: Context, args: string[]): Promise<void> {
  const [action, id, ...extra] = args;
  if (action === undefined) {
    const all = await context.backend.listSchedules();
    context.print(`schedules (${all.length})`);
    for (const schedule of all) context.print(`  ${formatSchedule(schedule)}`);
    return;
  }
  if ((action !== 'pause' && action !== 'resume' && action !== 'rm') || id === undefined || extra.length > 0)
    throw new UsageError('schedules takes nothing, or pause, resume or rm and a schedule id');
  if (action === 'rm') {
    await context.backend.removeSchedule(id);
    return context.print(`removed ${id}`);
  }
  const schedule = await context.backend.updateSchedule(id, { paused: action === 'pause' });
  context.print(
    action === 'pause'
      ? `paused ${id}`
      : `resumed ${id}${schedule.nextRunAt ? `, next run ${localTime(schedule.nextRunAt)}` : ''}`,
  );
}

async function chooseInTerminal(): Promise<Choice> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await terminal.question('[r]equeue it, [n]ew task anyway, [a]bort? ')).trim().toLowerCase();
      if (answer === 'r' || answer === 'requeue') return 'requeue';
      if (answer === 'n' || answer === 'new') return 'new';
      if (answer === 'a' || answer === 'abort' || answer === '') return 'abort';
    }
  } finally {
    terminal.close();
  }
}

export async function scheduleCommand(context: Context, flags: ScheduleFlags, words: string[]): Promise<void> {
  const args = parseScheduleArgs(flags, words);
  await schedule(
    {
      backend: context.backend,
      machine: context.config.machine,
      workdir: realpathSync(process.cwd()),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      print: context.print,
      check: haikuDuplicateCheck(context.print),
      choose: process.stdin.isTTY && process.stdout.isTTY ? chooseInTerminal : undefined,
    },
    args,
  );
}
