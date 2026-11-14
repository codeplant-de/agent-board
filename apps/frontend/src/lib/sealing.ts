import {
  ContractError,
  defaultTitle,
  newTaskId,
  openNote,
  QuestionError,
  sealAnswers,
  sealFields,
  sealNote,
  type Answer,
  type Keys,
  type Priority,
  type RowRef,
} from '@agent-board/shared';
import { sealerFor } from './contexts';
import { openerFor } from './opening';
import type { RouterInputs, RouterOutputs } from './wire';

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
 * The answers checked against the questions they answer (opened from the question note as it stands on the board now), then
 * sealed together with those questions, so that what the agent is told comes from the answer alone.
 */
export async function sealAnswer(
  keys: Keys,
  options: { id: string; questionNoteId: string; answers: Answer[]; message: string },
  thread: RouterOutputs['tasks']['get']['thread'],
): Promise<RouterInputs['tasks']['answer']> {
  const { id, questionNoteId, message } = options;
  const unreadable = new InputError('This question cannot be read, so it cannot be answered here.');
  const wire = thread.find((note) => note.id === questionNoteId);
  const asked = wire === undefined ? undefined : await openNote(openerFor(keys), id, wire);
  if (asked === undefined || asked.unreadable || asked.questions === undefined || wire?.kind !== 'question')
    throw unreadable;
  const text = message.trim();
  return {
    id,
    questionNoteId,
    answers: await checked(() => sealAnswers(sealerFor(keys), id, asked.questions ?? [], options.answers)),
    message: await checked(() => sealNote(sealerFor(keys), { taskId: id, author: 'user', kind: 'answer' }, text)),
  };
}
