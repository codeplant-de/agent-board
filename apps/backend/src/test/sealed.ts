import {
  blindIndex,
  deriveKeys,
  generateDataKey,
  notePreview,
  open,
  seal,
  type Answer,
  type Keys,
  type Question,
} from '@agent-board/shared';

/** Plaintext that tests put into sealed fields: none of it may ever reach a database column. */
export const MARKERS = [
  'MARKER-title-7f3a',
  'MARKER-prompt-9c21',
  'MARKER-workdir-4be8',
  'MARKER-comment-1d05',
  'MARKER-question-6a77',
  'MARKER-answer-c3e9',
  'MARKER-message-52fb',
  'MARKER-pause-8e14',
  'MARKER-fail-a0d6',
  'MARKER-tooluse-3b92',
  'MARKER-output-e7c1',
  'MARKER-pr-5f48',
];

const keysByOwner = new Map<string, Promise<Keys>>();

/** One random data key per owner for the whole test file, as a real user has one per account. */
export function keysFor(owner = 'jascha'): Promise<Keys> {
  let keys = keysByOwner.get(owner);
  if (keys === undefined) {
    keys = deriveKeys(generateDataKey(), owner, { index: true });
    keysByOwner.set(owner, keys);
  }
  return keys;
}

/** Seals and opens every field of a user's content with the field's own context, as a client does. */
export function sealerFor(owner = 'jascha') {
  const sealed = async (field: Parameters<typeof seal>[1], context: string, text: string) =>
    seal(await keysFor(owner), field, context, text);
  const opened = async (field: Parameters<typeof open>[1], context: string, envelope: string) =>
    open(await keysFor(owner), field, context, envelope);
  return {
    title: (text: string) => sealed('title', '', text),
    input: (text: string) => sealed('input', '', text),
    workdir: (text: string) => sealed('workdir', '', text),
    noteBody: (taskId: string, text: string) => sealed('note.body', taskId, text),
    notePreview: (taskId: string, text: string) => sealed('note.preview', taskId, text),
    questions: (taskId: string, questions: Question[]) => sealed('note.questions', taskId, JSON.stringify(questions)),
    answers: (taskId: string, answers: Answer[]) => sealed('note.answers', taskId, JSON.stringify(answers)),
    trData: (runId: string, seq: number, data: unknown) => sealed('tr.data', `${runId}:${seq}`, JSON.stringify(data)),
    trOutput: (runId: string, seq: number, output: string) => sealed('tr.output', `${runId}:${seq}`, output),
    dedupeKey: async (url: string) => blindIndex(await keysFor(owner), url),
    /** A note as the clients send it: sealed text and, for a note with text, its sealed preview. */
    note: async (taskId: string, text: string) => {
      const preview = notePreview(text);
      return {
        body: await sealed('note.body', taskId, text),
        ...(preview === null ? {} : { preview: await sealed('note.preview', taskId, preview) }),
      };
    },
    open: {
      title: (envelope: string) => opened('title', '', envelope),
      input: (envelope: string) => opened('input', '', envelope),
      workdir: (envelope: string) => opened('workdir', '', envelope),
      noteBody: (taskId: string, envelope: string) => opened('note.body', taskId, envelope),
      notePreview: (taskId: string, envelope: string) => opened('note.preview', taskId, envelope),
      questions: async (taskId: string, envelope: string) =>
        JSON.parse(await opened('note.questions', taskId, envelope)) as Question[],
      answers: async (taskId: string, envelope: string) =>
        JSON.parse(await opened('note.answers', taskId, envelope)) as Answer[],
      trData: async (runId: string, seq: number, envelope: string) =>
        JSON.parse(await opened('tr.data', `${runId}:${seq}`, envelope)) as Record<string, unknown>,
      trOutput: (runId: string, seq: number, envelope: string) => opened('tr.output', `${runId}:${seq}`, envelope),
    },
  };
}

export type Sealer = ReturnType<typeof sealerFor>;

export const sealed = sealerFor();
