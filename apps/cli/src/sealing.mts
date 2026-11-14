// The CLI's end-to-end encryption: the board server stores and returns sealed values it cannot read, and this wrapper
// seals what the rest of the CLI sends and opens what it receives, so `Backend` stays plaintext.
import {
  blindIndex,
  notePreview,
  open,
  parseAnswers,
  parseQuestions,
  QuestionError,
  seal,
  taskLabels,
  UNREADABLE_TITLE,
} from '@agent-board/shared';
import type {
  Backend,
  Field,
  Keys,
  Note,
  Question,
  Schedule,
  Task,
  TaskDraft,
  TaskPatch,
  TranscriptBatch,
  TranscriptEvent,
  UnreadableField,
  WireBackend,
  WireNote,
  WireNoteInput,
  WireSchedule,
  WireTask,
  WireTaskDraft,
  WireTaskPatch,
  WireTranscriptEvent,
} from '@agent-board/shared';
import { BackendError, createWebBackend } from './backend.mts';
import type { WebBackendOptions } from './backend.mts';

const invalid = (command: string, message: string): BackendError => new BackendError(`${command}: ${message}`, 400);

function requireAbsolute(command: string, workdir: string | null | undefined): void {
  if (workdir !== undefined && workdir !== null && !workdir.startsWith('/'))
    throw invalid(command, 'workdir must be an absolute path');
}

/** Opens one value; undefined when it cannot be opened: legacy plain text, another key, or damage. */
async function tryOpen(keys: Keys, field: Field, context: string, value: string): Promise<string | undefined> {
  try {
    return await open(keys, field, context, value);
  } catch {
    return undefined;
  }
}

/** Opens a sealed JSON value and checks its shape; undefined when either fails. */
async function tryOpenJson<T>(
  keys: Keys,
  field: Field,
  context: string,
  value: string,
  check: (json: unknown) => T,
): Promise<T | undefined> {
  const text = await tryOpen(keys, field, context, value);
  if (text === undefined) return undefined;
  try {
    return check(JSON.parse(text));
  } catch {
    return undefined;
  }
}

interface Sealed {
  title: string;
  input: string;
  workdir: string | null;
  unreadable: UnreadableField[];
}

/**
 * Opens the title, input and workdir of a task or schedule. A field that cannot be opened (or a workdir that is not an
 * absolute path) is listed in `unreadable` and replaced: the title by a placeholder, the input by an empty prompt, the
 * workdir by none. Callers that run a task check `unreadable` before they do.
 */
async function openFields(keys: Keys, wire: { title: string; input: string; workdir: string | null }): Promise<Sealed> {
  const [title, input, workdir] = await Promise.all([
    tryOpen(keys, 'title', '', wire.title),
    tryOpen(keys, 'input', '', wire.input),
    wire.workdir === null ? null : tryOpen(keys, 'workdir', '', wire.workdir),
  ]);
  const unreadable: UnreadableField[] = [];
  if (title === undefined) unreadable.push('title');
  if (input === undefined) unreadable.push('input');
  const validWorkdir = workdir === undefined || workdir === null || workdir.startsWith('/');
  if (!validWorkdir || workdir === undefined) unreadable.push('workdir');
  return {
    title: title ?? UNREADABLE_TITLE,
    input: input ?? '',
    workdir: workdir !== undefined && validWorkdir ? workdir : null,
    unreadable,
  };
}

async function openTask(keys: Keys, wire: WireTask): Promise<Task> {
  const { title, input, workdir, unreadable } = await openFields(keys, wire);
  return { ...wire, title, input, workdir, labels: taskLabels({ input, createdBy: wire.createdBy }), unreadable };
}

async function openSchedule(keys: Keys, wire: WireSchedule): Promise<Schedule> {
  return { ...wire, ...(await openFields(keys, wire)) };
}

/**
 * The server's own events (author "server") are plain text and shown as system notes. Any other note is opened; one that
 * cannot be opened, or whose questions or answers do not parse, comes back `unreadable` with no text, so it is never taken
 * for what the user wrote.
 */
async function openNote(keys: Keys, taskId: string, wire: WireNote): Promise<Note> {
  const base = { id: wire.id, createdAt: wire.createdAt, kind: wire.kind };
  if (wire.author === 'server')
    return {
      ...base,
      text: wire.kind === 'event' ? wire.body : '',
      author: 'system',
      unreadable: wire.kind !== 'event',
    };
  const [text, questions, answers] = await Promise.all([
    tryOpen(keys, 'note.body', taskId, wire.body),
    wire.questions === undefined ? null : tryOpenJson(keys, 'note.questions', taskId, wire.questions, parseQuestions),
    wire.answers === undefined
      ? null
      : tryOpenJson(keys, 'note.answers', taskId, wire.answers, (json) => parseAnswers(undefined, json)),
  ]);
  const unreadable = text === undefined || questions === undefined || answers === undefined;
  return {
    ...base,
    text: text ?? '',
    author: wire.author,
    unreadable,
    ...(questions ? { questions } : {}),
    ...(answers ? { answers } : {}),
    ...(wire.questionNoteId !== undefined ? { questionNoteId: wire.questionNoteId } : {}),
  };
}

/** `Backend` over a `WireBackend`: seals on the way out, opens on the way in. `keys` may be resolved on first use. */
export function sealingBackend(inner: WireBackend, keys: Keys | (() => Promise<Keys>)): Backend {
  let resolved: Promise<Keys> | undefined;
  const getKeys = (): Promise<Keys> => (resolved ??= typeof keys === 'function' ? keys() : Promise.resolve(keys));
  const sealWith = async (field: Field, context: string, text: string): Promise<string> =>
    seal(await getKeys(), field, context, text);

  const sealNote = async (command: string, id: string, text: string): Promise<WireNoteInput> => {
    if (text.trim() === '') throw invalid(command, 'note text is empty');
    const preview = notePreview(text);
    return {
      body: await sealWith('note.body', id, text),
      ...(preview === null ? {} : { preview: await sealWith('note.preview', id, preview) }),
    };
  };

  const sealDraft = async (draft: TaskDraft): Promise<WireTaskDraft> => {
    const title = draft.title.trim();
    if (title === '') throw invalid('add-task', 'draft.title must not be empty');
    requireAbsolute('add-task', draft.workdir);
    const { dedupeKey, workdir, ...rest } = draft;
    return {
      ...rest,
      title: await sealWith('title', '', title),
      input: await sealWith('input', '', draft.input),
      ...(dedupeKey === undefined ? {} : { dedupeKey: await blindIndex(await getKeys(), dedupeKey) }),
      ...(workdir === undefined ? {} : { workdir: await sealWith('workdir', '', workdir) }),
    };
  };

  const sealPatch = async (patch: TaskPatch): Promise<WireTaskPatch> => {
    requireAbsolute('update-task', patch.workdir);
    const { input, workdir, ...rest } = patch;
    return {
      ...rest,
      ...(input === undefined ? {} : { input: await sealWith('input', '', input) }),
      ...(workdir === undefined ? {} : { workdir: workdir === null ? null : await sealWith('workdir', '', workdir) }),
    };
  };

  const sealEvent = async (runId: string, event: TranscriptEvent): Promise<WireTranscriptEvent> => {
    const context = `${runId}:${event.seq}`;
    const { seq, at, kind, parent } = event;
    if (event.kind !== 'tool_result')
      return { seq, at, kind, parent, data: await sealWith('tr.data', context, JSON.stringify(event)) };
    const { output, ...rest } = event;
    return {
      seq,
      at,
      kind,
      parent,
      data: await sealWith('tr.data', context, JSON.stringify(rest)),
      output: await sealWith('tr.output', context, output),
      outputSize: output.length,
    };
  };

  const opened = async <T, R>(wire: T, open: (keys: Keys, value: T) => Promise<R>): Promise<R> =>
    open(await getKeys(), wire);
  const openedAll = async <T, R>(wire: T[], open: (keys: Keys, value: T) => Promise<R>): Promise<R[]> => {
    const resolvedKeys = await getKeys();
    return Promise.all(wire.map((value) => open(resolvedKeys, value)));
  };

  return {
    listTasks: async (options) => openedAll(await inner.listTasks(options), openTask),
    getTask: async (id) => opened(await inner.getTask(id), openTask),
    async addTask(draft) {
      const { task, created } = await inner.addTask(await sealDraft(draft));
      return { task: await opened(task, openTask), created };
    },
    async updateTask(id, patch) {
      return opened(await inner.updateTask(id, await sealPatch(patch)), openTask);
    },
    async claimTask(id, machine) {
      const claimed = await inner.claimTask(id, machine);
      return claimed === undefined ? undefined : opened(claimed, openTask);
    },
    addNote: async (id, text, options) => inner.addNote(id, await sealNote('add-note', id, text), options),
    async ask(id, questions: Question[]) {
      let checked: Question[];
      try {
        checked = parseQuestions(questions);
      } catch (error) {
        if (error instanceof QuestionError) throw invalid('ask', error.message);
        throw error;
      }
      await inner.ask(id, {
        body: await sealWith('note.body', id, ''),
        questions: await sealWith('note.questions', id, JSON.stringify(checked)),
      });
    },
    heartbeat: (id, beat) => inner.heartbeat(id, beat),
    async pause(id, note) {
      return opened(await inner.pause(id, await sealNote('pause', id, note.trim())), openTask);
    },
    async fail(id, text) {
      const { applied, task } = await inner.fail(id, await sealNote('fail', id, text.trim()));
      return { applied, task: await opened(task, openTask) };
    },
    async transcript(id, batch: TranscriptBatch) {
      const events = await Promise.all(batch.events.map((event) => sealEvent(batch.runId, event)));
      await inner.transcript(id, { ...batch, events });
    },
    async readNotes(id) {
      const wire = await inner.readNotes(id);
      const resolvedKeys = await getKeys();
      return Promise.all(wire.map((note) => openNote(resolvedKeys, id, note)));
    },
    async addSchedule(draft) {
      const title = draft.title.trim();
      if (title === '') throw invalid('add-schedule', 'schedule draft.title must not be empty');
      if (draft.input.trim() === '') throw invalid('add-schedule', 'schedule draft.input must not be empty');
      requireAbsolute('add-schedule', draft.workdir);
      const { workdir, ...rest } = draft;
      const { schedule, task } = await inner.addSchedule({
        ...rest,
        title: await sealWith('title', '', title),
        input: await sealWith('input', '', draft.input),
        ...(workdir === undefined ? {} : { workdir: await sealWith('workdir', '', workdir) }),
      });
      return { schedule: await opened(schedule, openSchedule), task: await opened(task, openTask) };
    },
    listSchedules: async () => openedAll(await inner.listSchedules(), openSchedule),
    updateSchedule: async (id, patch) => opened(await inner.updateSchedule(id, patch), openSchedule),
    removeSchedule: (id) => inner.removeSchedule(id),
  };
}

/** The board over HTTP, sealed with the data key from the credentials file. */
export function createSealedBackend(options: WebBackendOptions): Backend {
  const web = createWebBackend(options);
  return sealingBackend(web, () => web.keys());
}
