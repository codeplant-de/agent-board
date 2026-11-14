import {
  defaultTitle,
  notePreview,
  parseAnswers,
  parseQuestions,
  QuestionError,
  type Answer,
  type Keys,
  type Priority,
  type Question,
} from '@agent-board/shared';
import { noteAnswers, noteBody, notePreviewOf, noteQuestions, sealAs, taskFields } from './contexts';
import { tryOpen } from './opening';
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

export async function sealNewTask(keys: Keys, task: NewTask): Promise<CreateInput> {
  const input = task.input.trim();
  if (input === '') throw new InputError('Write a prompt first');
  const title = (task.title ?? '').trim() || defaultTitle(input);
  return {
    title: await sealAs(keys, taskFields().title, title),
    input: await sealAs(keys, taskFields().input, input),
    ...(task.priority === undefined ? {} : { priority: task.priority }),
    ...(task.when === undefined ? {} : { when: task.when }),
  };
}

export async function sealNote(keys: Keys, taskId: string, text: string): Promise<NoteInput> {
  const preview = notePreview(text);
  return {
    body: await sealAs(keys, noteBody(taskId), text),
    ...(preview === null ? {} : { preview: await sealAs(keys, notePreviewOf(taskId), preview) }),
  };
}

export async function sealReply(keys: Keys, taskId: string, message: string): Promise<NoteInput> {
  const text = message.trim();
  if (text === '') throw new InputError('Write something first.');
  return sealNote(keys, taskId, text);
}

/** The answers checked against the questions they answer (found in the opened thread), then sealed. */
export async function sealAnswer(
  keys: Keys,
  options: { id: string; questionNoteId: string; answers: Answer[]; message: string },
  thread: RouterOutputs['tasks']['get']['thread'],
): Promise<RouterInputs['tasks']['answer']> {
  const { id, questionNoteId, message } = options;
  const unreadable = new InputError('This question cannot be read, so it cannot be answered here.');
  const wire = thread.find((note) => note.id === questionNoteId)?.questions;
  const text = wire === undefined ? undefined : await tryOpen(keys, noteQuestions(id), wire);
  if (text === undefined) throw unreadable;
  let questions: Question[];
  try {
    questions = parseQuestions(JSON.parse(text));
  } catch {
    throw unreadable;
  }
  let answers: Answer[];
  try {
    answers = parseAnswers(questions, options.answers);
  } catch (error) {
    if (error instanceof QuestionError) throw new InputError(error.message);
    throw error;
  }
  return {
    id,
    questionNoteId,
    answers: await sealAs(keys, noteAnswers(id), JSON.stringify(answers)),
    message: await sealNote(keys, id, message.trim()),
  };
}
