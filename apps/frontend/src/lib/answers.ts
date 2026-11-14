import type { Question } from '@agent-board/shared';
import type { ThreadNote } from './opening';

/** Every pairing of an opened answer with its questions goes through here. */
export function answerTo(thread: ThreadNote[], question: ThreadNote): ThreadNote | undefined {
  return thread.find((note) => note.kind === 'answer' && note.questionNoteId === question.id);
}

export function questionsAnswered(thread: ThreadNote[], answer: ThreadNote): Question[] | undefined {
  return thread.find((note) => note.id === answer.questionNoteId)?.questions;
}
