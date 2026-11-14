#!/usr/bin/env node
/**
 *   board comment <task> <text>   add a note (long text is fine; `-` reads the text from stdin)
 *   board comment <task> --file <path>   add a note from a file in /tmp
 *   board move <task> <status>    move a task to the bottom of a status (todo, running, needs-me, done)
 *   board notify <task> <text>    Slack message with the task link
 *   board tasks                   open tasks per status
 *   board ask <task> --file <path>      ask the user 1-4 questions (JSON in /tmp) and move the task to needs-me
 *   board show <task>             the task and its thread as markdown
 *   board schedule [--priority p] [--title t] [--hold] [--new] <prompt...>
 *                                 a task from a prompt, run in this directory on this machine; checks for duplicates first
 *                                 (not inside a board run: there, propose follow-up work with `board add`)
 *   board add --title <t> --file <path> [--parent <task>] [--priority urgent|high|normal|low]
 *                                 propose a follow-up task (the file is its prompt); it waits in needs-me until the user starts it
 *
 * <task> is the task id the backend gives. Add --dry-run to print writes.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { buildContext, readStdin, rejectExtraArgs, runMain, takeFlag, UsageError } from './cli.mts';
import type { Context } from './cli.mts';
import { BackendError } from './backend.mts';
import {
  formatAnswers,
  formatQuestions,
  isPriority,
  isSafeTaskId,
  isStatus,
  parseQuestions,
  PRIORITIES,
  QuestionError,
  STATUSES,
} from '@agent-board/shared';
import type { Note, Priority, Status, Task } from '@agent-board/shared';
import { postSlack, slackText } from './notify.mts';
import { haikuDuplicateCheck, parseScheduleArgs, schedule } from './schedule.mts';
import type { Choice } from './schedule.mts';

const USAGE =
  'usage: board comment <task> <text|--file path> | move <task> <status> | notify <task> <text> | ask <task> --file <path> | show <task> | schedule [--priority <p>] [--title <t>] [--hold] [--new] <prompt...> | add --title <t> --file <path> [--parent <task>] [--priority <p>] | tasks';

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

async function notify(context: Context, id: string, text: string): Promise<void> {
  const message = slackText(await context.backend.getTask(id), text);
  if (context.dryRun) return context.print(`DRY slack ${message.replaceAll('\n', ' | ')}`);
  await postSlack(context.config.slackWebhookFile, message);
}

async function tasks(context: Context): Promise<void> {
  const open = await context.backend.listTasks();
  for (const status of STATUSES) {
    const inStatus = open.filter((task) => task.status === status);
    context.print(`${status} (${inStatus.length})`);
    for (const task of inStatus)
      context.print(`  ${task.id}  ${task.priority.padEnd(6)}  [${task.labels.join(',') || '-'}]  ${task.title}`);
  }
}

async function ask(context: Context, id: string, path: string): Promise<void> {
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

async function show(context: Context, id: string): Promise<void> {
  const [task, notes] = await Promise.all([context.backend.getTask(id), context.backend.readNotes(id)]);
  context.print(renderThread(task, notes));
}

// `add --title <t> --file <path> [--parent <task>] [--priority <p>]`, flags in any order.
export function parseAddArgs(args: string[]): {
  title: string;
  file: string;
  parent: string | undefined;
  priority: Priority | undefined;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !flag ||
      !['--title', '--file', '--parent', '--priority'].includes(flag) ||
      value === undefined ||
      values.has(flag)
    )
      throw new UsageError(USAGE);
    values.set(flag, value);
  }
  const title = values.get('--title')?.trim();
  const file = values.get('--file');
  const parent = values.get('--parent');
  if (!title || !file) throw new UsageError(USAGE);
  if (parent !== undefined && !isSafeTaskId(parent)) throw new UsageError(`"${parent.slice(0, 40)}" is not a task id`);
  const priority = values.get('--priority');
  if (priority !== undefined && !isPriority(priority))
    throw new UsageError(`unknown priority "${priority.slice(0, 20)}"; use one of ${PRIORITIES.join(', ')}`);
  return { title, file, parent, priority };
}

// The board puts a proposal in Needs me itself, so no status is sent.
export async function add(context: Context, args: string[]): Promise<void> {
  const { title, file, parent, priority } = parseAddArgs(args);
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

async function scheduleCommand(context: Context, args: string[]): Promise<void> {
  await schedule(
    {
      backend: context.backend,
      machine: context.config.machine,
      workdir: realpathSync(process.cwd()),
      print: context.print,
      check: haikuDuplicateCheck(context.print),
      choose: process.stdin.isTTY && process.stdout.isTTY ? chooseInTerminal : undefined,
    },
    parseScheduleArgs(args),
  );
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env): Promise<void> {
  const args = [...argv];
  const dryRun = takeFlag(args, '--dry-run');
  if (args[0] === 'add') return add(buildContext(dryRun), args.slice(1));
  if (args[0] === 'schedule') {
    // A run's agent works on untrusted text; a task it schedules would run with the user's full permissions.
    if (env['AGENT_BOARD_TASK'])
      throw new UsageError(
        'board schedule is not available inside a board run; use `board add` to propose follow-up work',
      );
    return scheduleCommand(buildContext(dryRun), args.slice(1));
  }
  const [command, id, ...rest] = args;
  if (!command || command.startsWith('--') || id?.startsWith('--')) throw new UsageError(USAGE);
  if (command === 'tasks' && (id !== undefined || rest.length > 0)) rejectExtraArgs([id ?? '', ...rest], USAGE);
  const context = buildContext(dryRun);
  if (command === 'show') {
    if (!id || rest.length > 0) throw new UsageError(USAGE);
    return show(context, id);
  }
  if (command === 'ask') {
    if (!id || rest.length !== 2 || rest[0] !== '--file') throw new UsageError(USAGE);
    return ask(context, id, rest[1] ?? '');
  }
  const fromFile = command === 'comment' && rest[0] === '--file';
  if (fromFile && rest.length !== 2) throw new UsageError(USAGE);
  const text = fromFile
    ? readNoteFile(rest[1] ?? '')
    : rest.join(' ') === '-'
      ? (await readStdin()).trim()
      : rest.join(' ');
  switch (command) {
    case 'comment':
      if (!id || !text) throw new UsageError(USAGE);
      return context.backend.addNote(id, text);
    case 'notify':
      if (!id || !text) throw new UsageError(USAGE);
      return notify(context, id, text);
    case 'move':
      if (!id || !text) throw new UsageError(USAGE);
      return move(context, id, parseStatus(text));
    case 'tasks':
      return tasks(context);
    default:
      throw new UsageError(USAGE);
  }
}

if (import.meta.main) await runMain(() => main(process.argv.slice(2)));
