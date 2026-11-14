// The CLI's end-to-end encryption: the board server stores and returns sealed values it cannot read, and this wrapper
// seals what the rest of the CLI sends and opens what it receives, so `Backend` stays plaintext. The rules of what is sealed
// under which binding live in `packages/shared/src/sealing.mts`, which the browser uses too.
import {
  ContractError,
  dedupeKeyIndex,
  isSafeWorkdir,
  newTaskId,
  open,
  openFields,
  openNote,
  headIndex,
  QuestionError,
  seal,
  sealChecked,
  sealFields,
  sealInput,
  sealNote,
  sealQuestions,
  sealWorkdir,
  taskLabels,
  transcriptBinding,
} from '@agent-board/shared';
import type {
  Backend,
  Keys,
  Note,
  Opener,
  Question,
  RowRef,
  Schedule,
  Sealer,
  Task,
  TaskDraft,
  TaskPatch,
  TranscriptBatch,
  TranscriptEvent,
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

/** What sealing refuses (a text past the board's limit, answers that do not fit) is a usage error naming the command. */
async function checked<T>(command: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ContractError || error instanceof QuestionError) throw invalid(command, error.message);
    throw error;
  }
}

function requireAbsolute(command: string, workdir: string | null | undefined): void {
  if (workdir !== undefined && workdir !== null && !isSafeWorkdir(workdir))
    throw invalid(command, 'workdir must be an absolute path');
}

const sealerFor =
  (keys: Keys): Sealer =>
  (binding, plaintext) =>
    seal(keys, binding.field, binding.context, plaintext);

/** Opens one value; undefined when it cannot be opened under that binding: plain text, another key, another binding, damage. */
const openerFor =
  (keys: Keys): Opener =>
  async (binding, value) => {
    try {
      return await open(keys, binding.field, binding.context, value);
    } catch {
      return undefined;
    }
  };

const taskRef = (task: Pick<WireTask, 'id' | 'createdBy' | 'scheduleId'>): RowRef => ({
  kind: 'task',
  id: task.id,
  createdBy: task.createdBy,
  scheduleId: task.scheduleId,
});

async function openTask(keys: Keys, wire: WireTask): Promise<Task> {
  const { title, input, workdir, unreadable } = await openFields(openerFor(keys), taskRef(wire), wire);
  return { ...wire, title, input, workdir, labels: taskLabels({ input, createdBy: wire.createdBy }), unreadable };
}

async function openSchedule(keys: Keys, wire: WireSchedule): Promise<Schedule> {
  return { ...wire, ...(await openFields(openerFor(keys), { kind: 'schedule', id: wire.id }, wire)) };
}

/**
 * Opens a thread note by the shared rules: a server event only for one of its fixed texts and kept as author "server"; any
 * other note only under its own author and kind. One that cannot be opened comes back `unreadable` with no text, so it is
 * never taken for what the user wrote.
 */
async function openThreadNote(keys: Keys, taskId: string, wire: WireNote): Promise<Note> {
  const opened = await openNote(openerFor(keys), taskId, wire);
  return {
    id: wire.id,
    createdAt: wire.createdAt,
    kind: wire.kind,
    ...opened,
    ...(wire.questionNoteId !== undefined ? { questionNoteId: wire.questionNoteId } : {}),
  };
}

/** `Backend` over a `WireBackend`: seals on the way out, opens on the way in. `keys` may be resolved on first use. */
export function sealingBackend(inner: WireBackend, keys: Keys | (() => Promise<Keys>)): Backend {
  let resolved: Promise<Keys> | undefined;
  const getKeys = (): Promise<Keys> => (resolved ??= typeof keys === 'function' ? keys() : Promise.resolve(keys));
  const sealer: Sealer = async (binding, plaintext) => sealerFor(await getKeys())(binding, plaintext);

  const noteInput = async (
    command: string,
    taskId: string,
    author: 'agent' | 'system',
    text: string,
    options: { suggestion?: string } = {},
  ): Promise<WireNoteInput> => {
    if (text.trim() === '') throw invalid(command, 'note text is empty');
    return checked(command, () =>
      sealNote(sealer, { taskId, author, kind: author === 'agent' ? 'comment' : 'event' }, text, options),
    );
  };

  const sealDraft = async (draft: TaskDraft): Promise<WireTaskDraft> => {
    const title = draft.title.trim();
    if (title === '') throw invalid('add-task', 'draft.title must not be empty');
    requireAbsolute('add-task', draft.workdir);
    const { dedupeKey, workdir, head, id: chosen, ...rest } = draft;
    const id = chosen ?? newTaskId();
    const row: RowRef = { kind: 'task', id, createdBy: draft.createdBy ?? 'user', scheduleId: null };
    const sealed = await checked('add-task', () => sealFields(sealer, row, { title, input: draft.input, workdir }));
    const keysNow = await getKeys();
    return {
      ...rest,
      id,
      ...sealed,
      ...(dedupeKey === undefined ? {} : { dedupeKey: await dedupeKeyIndex(keysNow, dedupeKey) }),
      ...(head === undefined ? {} : { head: await headIndex(keysNow, head) }),
    };
  };

  const sealPatch = async (id: string, patch: TaskPatch): Promise<WireTaskPatch> => {
    requireAbsolute('update-task', patch.workdir);
    const { input, workdir, head, seal: writer, ...rest } = patch;
    const needsRow = input !== undefined || (workdir !== undefined && workdir !== null);
    if (needsRow && writer === undefined)
      throw invalid('update-task', 'sealing an input or a directory needs the task creator and schedule (patch.seal)');
    const row: RowRef = {
      kind: 'task',
      id,
      createdBy: writer?.createdBy ?? 'user',
      scheduleId: writer?.scheduleId ?? null,
    };
    const sealed = await checked('update-task', async () => ({
      ...(input === undefined ? {} : { input: await sealInput(sealer, row, input) }),
      ...(workdir === undefined || workdir === null ? {} : { workdir: await sealWorkdir(sealer, row, workdir) }),
    }));
    return {
      ...rest,
      ...sealed,
      ...(workdir === null ? { workdir: null } : {}),
      ...(head === undefined ? {} : { head: head === null ? null : await headIndex(await getKeys(), head) }),
    };
  };

  const sealEvent = async (taskId: string, runId: string, event: TranscriptEvent): Promise<WireTranscriptEvent> => {
    const { seq, at, kind, parent } = event;
    const dataBinding = transcriptBinding('tr.data', taskId, runId, seq);
    if (event.kind !== 'tool_result')
      return {
        seq,
        at,
        kind,
        parent,
        data: await sealChecked(sealer, dataBinding, JSON.stringify(event), `event ${seq}`),
      };
    const { output, ...rest } = event;
    return {
      seq,
      at,
      kind,
      parent,
      data: await sealChecked(sealer, dataBinding, JSON.stringify(rest), `event ${seq}`),
      output: await sealChecked(
        sealer,
        transcriptBinding('tr.output', taskId, runId, seq),
        output,
        `the output of event ${seq}`,
      ),
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
    async attachSession(id) {
      const { sessionId, workdir } = await opened(await inner.attachSession(id), openTask);
      if (sessionId === null) throw invalid('attach-session', 'the answer has no session');
      return { sessionId, workdir };
    },
    async addTask(draft) {
      const { task, created } = await inner.addTask(await sealDraft(draft));
      return { task: await opened(task, openTask), created };
    },
    async updateTask(id, patch) {
      return opened(await inner.updateTask(id, await sealPatch(id, patch)), openTask);
    },
    async claimTask(id, machine) {
      const claimed = await inner.claimTask(id, machine);
      return claimed === undefined ? undefined : opened(claimed, openTask);
    },
    addNote: async (id, text, { author = 'agent', suggestion } = {}) =>
      inner.addNote(id, await noteInput('add-note', id, author, text, suggestion === undefined ? {} : { suggestion }), {
        author,
      }),
    async ask(id, questions: Question[]) {
      await inner.ask(id, await checked('ask', () => sealQuestions(sealer, id, questions)));
    },
    heartbeat: (id, beat) => inner.heartbeat(id, beat),
    async pause(id, note) {
      return opened(await inner.pause(id, await noteInput('pause', id, 'system', note.trim())), openTask);
    },
    async fail(id, text) {
      const { applied, task } = await inner.fail(id, await noteInput('fail', id, 'system', text.trim()));
      return { applied, task: await opened(task, openTask) };
    },
    async transcript(id, batch: TranscriptBatch) {
      const events = await checked('transcript', () =>
        Promise.all(batch.events.map((event) => sealEvent(id, batch.runId, event))),
      );
      await inner.transcript(id, { ...batch, events });
    },
    async readNotes(id) {
      const wire = await inner.readNotes(id);
      const resolvedKeys = await getKeys();
      return Promise.all(wire.map((note) => openThreadNote(resolvedKeys, id, note)));
    },
    async addSchedule(draft) {
      const title = draft.title.trim();
      if (title === '') throw invalid('add-schedule', 'schedule draft.title must not be empty');
      if (draft.input.trim() === '') throw invalid('add-schedule', 'schedule draft.input must not be empty');
      requireAbsolute('add-schedule', draft.workdir);
      const { workdir, id: chosen, ...rest } = draft;
      const id = chosen ?? newTaskId();
      const sealed = await checked('add-schedule', () =>
        sealFields(sealer, { kind: 'schedule', id }, { title, input: draft.input, workdir }),
      );
      const { schedule, task } = await inner.addSchedule({ ...rest, id, ...sealed });
      return { schedule: await opened(schedule, openSchedule), task: await opened(task, openTask) };
    },
    listSchedules: async () => openedAll(await inner.listSchedules(), openSchedule),
    updateSchedule: async (id, patch) => opened(await inner.updateSchedule(id, patch), openSchedule),
    removeSchedule: (id) => inner.removeSchedule(id),
    indexHead: async (sha) => headIndex(await getKeys(), sha),
  };
}

/** The board over HTTP, sealed with the data key from the credentials file. */
export function createSealedBackend(options: WebBackendOptions): Backend {
  const web = createWebBackend(options);
  return sealingBackend(web, () => web.keys());
}
