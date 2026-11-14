import {
  ContractError,
  defaultTitle,
  newTaskId,
  QuestionError,
  sealAnswers,
  sealFields,
  sealInput,
  sealNote,
  type Answer,
  type Keys,
  type Priority,
  type Question,
  type RowRef,
  type Status,
  type TaskCreator,
  type UnreadableField,
} from '@agent-board/shared';
import { sealerFor } from './contexts';
import type { RouterInputs } from './wire';

export class InputError extends Error {}

type CreateInput = RouterInputs['tasks']['create'];
type NoteInput = RouterInputs['tasks']['reply']['message'];

export interface NewTask {
  title?: string;
  input: string;
  priority?: Priority;
  when?: CreateInput['when'];
}

/** What the shared sealing refuses (a text past the board's limit, answers that do not fit) is something to tell the user. */
async function checked<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ContractError || error instanceof QuestionError) throw new InputError(error.message);
    throw error;
  }
}

const isRepeat = (when: CreateInput['when']): boolean =>
  typeof when === 'object' && ('every' in when || 'cron' in when);

export async function sealNewTask(keys: Keys, task: NewTask): Promise<CreateInput> {
  const input = task.input.trim();
  if (input === '') throw new InputError('Write a prompt first');
  const title = (task.title ?? '').trim() || defaultTitle(input);
  // The id is the task's, or the schedule's for a repeat (its occurrences are the server's): the fields are bound to it.
  const id = newTaskId();
  const row: RowRef = isRepeat(task.when)
    ? { kind: 'schedule', id }
    : { kind: 'task', id, createdBy: 'user', scheduleId: null };
  const sealed = await checked(() => sealFields(sealerFor(keys), row, { title, input }));
  return {
    id,
    title: sealed.title,
    input: sealed.input,
    ...(task.priority === undefined ? {} : { priority: task.priority }),
    ...(task.when === undefined ? {} : { when: task.when }),
  };
}

export async function sealComment(keys: Keys, taskId: string, text: string): Promise<NoteInput> {
  return checked(() => sealNote(sealerFor(keys), { taskId, author: 'user', kind: 'comment' }, text));
}

export async function sealReply(keys: Keys, taskId: string, message: string): Promise<NoteInput> {
  const text = message.trim();
  if (text === '') throw new InputError('Write something first.');
  return sealComment(keys, taskId, text);
}

/**
 * The answers checked against `questions`, then sealed together with them, so that what the agent is told comes from the answer
 * alone. `questions` are exactly the ones the panel showed (opened from the question note on screen), never ones fetched again
 * at submit time, which the board could have changed in between.
 */
export async function sealAnswer(
  keys: Keys,
  options: { id: string; questionNoteId: string; questions: Question[]; answers: Answer[]; message: string },
): Promise<RouterInputs['tasks']['answer']> {
  const { id, questionNoteId, questions, message } = options;
  const text = message.trim();
  return {
    id,
    questionNoteId,
    answers: await checked(() => sealAnswers(sealerFor(keys), id, questions, options.answers)),
    message: await checked(() => sealNote(sealerFor(keys), { taskId: id, author: 'user', kind: 'answer' }, text)),
  };
}

/** What starting an agent's proposal needs of the proposal as the page shows it. */
export interface Proposal {
  id: string;
  status: Status;
  input: string;
  createdBy: TaskCreator;
  scheduleId: string | null;
  unreadable: UnreadableField[];
}

/**
 * A move starts a proposal only when an agent's task enters Todo from another column. One already in Todo was put there by the
 * board (a proposal never waits in Todo), so reordering it must not seal its prompt as the user's.
 */
export function startsProposal(task: Pick<Proposal, 'createdBy' | 'status'>, to: Status): boolean {
  return task.createdBy === 'agent' && task.status !== 'todo' && to === 'todo';
}

/**
 * Starting a proposal is the user's sealed act: its prompt, as the page showed it, sealed again for the creator "user", which is
 * the only thing a worker runs with the user's permissions. Throws when the prompt could not be read, since sealing the
 * placeholder would start something else.
 */
export async function sealStart(keys: Keys, proposal: Proposal): Promise<string> {
  if (proposal.createdBy !== 'agent') throw new InputError('Only a task an agent proposed is started this way.');
  if (proposal.unreadable.includes('input'))
    throw new InputError('This proposal’s prompt cannot be read, so it cannot be started here.');
  const row: RowRef = { kind: 'task', id: proposal.id, createdBy: 'user', scheduleId: proposal.scheduleId };
  return checked(() => sealInput(sealerFor(keys), row, proposal.input));
}
