import type { ThreadNote } from './opening';

/**
 * The answer shown with a question: the one the server filed under it, and only when the questions inside the answer are the
 * ones asked. An answer carries the questions its user was shown, so it can never be passed off as the answer to another.
 */
export function answerTo(thread: ThreadNote[], question: ThreadNote): ThreadNote | undefined {
  const asked = JSON.stringify(question.questions);
  return thread.find(
    (note) =>
      note.kind === 'answer' &&
      !note.unreadable &&
      note.questionNoteId === question.id &&
      JSON.stringify(note.questions) === asked,
  );
}
