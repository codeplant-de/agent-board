import { defaultTitle } from '@agent-board/shared';
import type { Answer, Question } from '@agent-board/shared';
import type { Db } from '../db/client';
import { caller } from './helpers';
import { sealerFor, type Sealer } from './sealed';

type Raw = ReturnType<typeof caller>;
// Machine API bodies and answers are untyped JSON.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MachineAnswer = { status: number; json: { result?: any; error?: string } };
export type MachineCall = (command: string, body?: Json) => Promise<MachineAnswer>;

const isEnvelope = (value: unknown): value is string => typeof value === 'string' && value.startsWith('abe1.');

/** Opens the sealed fields of any task, schedule or note found in a machine API result. */
async function openDeep(value: unknown, sealer: Sealer, taskId: string): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => openDeep(item, sealer, taskId)));
  if (typeof value !== 'object' || value === null) return value;
  const out: Json = {};
  for (const [key, item] of Object.entries(value)) out[key] = await openDeep(item, sealer, taskId);
  if (isEnvelope(out['title'])) out['title'] = await sealer.open.title(out['title']);
  if (isEnvelope(out['input'])) out['input'] = await sealer.open.input(out['input']);
  if (isEnvelope(out['workdir'])) out['workdir'] = await sealer.open.workdir(out['workdir']);
  if (typeof out['body'] === 'string' && typeof out['kind'] === 'string' && typeof out['author'] === 'string') {
    out['text'] = isEnvelope(out['body']) ? await sealer.open.noteBody(taskId, out['body']) : out['body'];
    if (isEnvelope(out['questions'])) out['questions'] = await sealer.open.questions(taskId, out['questions']);
    if (isEnvelope(out['answers'])) out['answers'] = await sealer.open.answers(taskId, out['answers']);
  }
  return out;
}

async function sealDraft(body: Json, sealer: Sealer): Promise<Json> {
  const { labels: _labels, ...rest } = body;
  const sealedFields: Json = {};
  if (typeof rest['title'] === 'string') sealedFields['title'] = await sealer.title(rest['title']);
  if (typeof rest['input'] === 'string' || 'title' in rest)
    sealedFields['input'] = await sealer.input(rest['input'] ?? '');
  if (typeof rest['workdir'] === 'string') sealedFields['workdir'] = await sealer.workdir(rest['workdir']);
  if (typeof rest['dedupeKey'] === 'string') sealedFields['dedupeKey'] = await sealer.dedupeKey(rest['dedupeKey']);
  return { ...rest, ...sealedFields };
}

async function sealRequest(command: string, request: Json, sealer: Sealer): Promise<Json> {
  const id = String(request['id'] ?? '');
  const body = request['body'];
  switch (command) {
    case 'add-task':
    case 'add-schedule':
      return { ...request, body: await sealDraft(body, sealer) };
    case 'update-task': {
      const patch: Json = { ...body };
      if (typeof patch['input'] === 'string') patch['input'] = await sealer.input(patch['input']);
      if (typeof patch['workdir'] === 'string') patch['workdir'] = await sealer.workdir(patch['workdir']);
      return { ...request, body: patch };
    }
    case 'add-note':
    case 'pause':
    case 'fail':
      return typeof body === 'string' ? { ...request, body: await sealer.note(id, body) } : request;
    case 'ask': {
      const questions: Question[] = Array.isArray(body) ? body : body.questions;
      return {
        ...request,
        body: { body: await sealer.noteBody(id, ''), questions: await sealer.questions(id, questions) },
      };
    }
    case 'transcript': {
      const events = await Promise.all(
        (body.events as Json[]).map(async ({ output, ...event }) => {
          const data = await sealer.trData(body.runId, event['seq'], event);
          if (event['kind'] !== 'tool_result') return { ...event, data };
          return {
            seq: event['seq'],
            at: event['at'],
            kind: event['kind'],
            parent: event['parent'],
            data,
            output: await sealer.trOutput(body.runId, event['seq'], output ?? ''),
            outputSize: (output ?? '').length,
          };
        }),
      );
      return { ...request, body: { ...body, events } };
    }
    default:
      return request;
  }
}

/**
 * Makes a client of a raw machine API call: plaintext in, as the CLI's sealing backend takes it, and plaintext out.
 * What it cannot seal (a body that is already an object) is sent as it is, so refusals can be tested through it too.
 */
export function plainMachine(raw: MachineCall, owner = 'jascha'): MachineCall {
  const sealer = sealerFor(owner);
  return async (command, request = {}) => {
    const answer = await raw(command, await sealRequest(command, request, sealer));
    if (answer.json.result === undefined) return answer;
    return {
      ...answer,
      json: { ...answer.json, result: await openDeep(answer.json.result, sealer, String(request['id'] ?? '')) },
    };
  };
}

type CreateInput = Omit<Parameters<Raw['tasks']['create']>[0], 'title' | 'input'> & { title?: string; input: string };

/** Makes a client of a tRPC caller: plaintext in and out, with the sealing the browser will do. */
export function plainUi(db: Db, owner = 'jascha') {
  const raw = caller(db, owner);
  const sealer = sealerFor(owner);

  const openTask = async <T extends { title: string; input: string; workdir: string | null }>(task: T) => ({
    ...task,
    title: await sealer.open.title(task.title),
    input: await sealer.open.input(task.input),
    workdir: task.workdir === null ? null : await sealer.open.workdir(task.workdir),
  });
  const openSchedule = openTask;
  const openNote = async <N extends { id: string; body: string; author: string; questions?: string; answers?: string }>(
    note: N,
    taskId: string,
  ) => ({
    ...note,
    text: note.author === 'server' ? note.body : await sealer.open.noteBody(taskId, note.body),
    questions: note.questions === undefined ? undefined : await sealer.open.questions(taskId, note.questions),
    answers: note.answers === undefined ? undefined : await sealer.open.answers(taskId, note.answers),
  });
  const mutation =
    <I extends { id: string }>(call: (input: I) => ReturnType<Raw['tasks']['done']>) =>
    async (input: I) =>
      openTask(await call(input));

  return {
    raw,
    sealer,
    tasks: {
      list: async (input?: Parameters<Raw['tasks']['list']>[0]) =>
        Promise.all(
          (await raw.tasks.list(input)).map(async ({ lastNote, ...task }) => ({
            ...(await openTask(task)),
            lastNote:
              lastNote === null
                ? null
                : {
                    ...lastNote,
                    text:
                      lastNote.preview === null
                        ? null
                        : lastNote.author === 'server'
                          ? lastNote.preview
                          : await sealer.open.notePreview(task.id, lastNote.preview),
                  },
          })),
        ),
      get: async (input: { id: string }) => {
        const { task, thread, followUps, parent } = await raw.tasks.get(input);
        return {
          task: await openTask(task),
          thread: await Promise.all(thread.map((note) => openNote(note, input.id))),
          followUps: await Promise.all(followUps.map(openTask)),
          parent: parent === null ? null : await openTask(parent),
        };
      },
      create: async ({ title, input, ...rest }: CreateInput) =>
        openTask(
          await raw.tasks.create({
            title: await sealer.title(title ?? defaultTitle(input)),
            input: await sealer.input(input),
            ...rest,
          }),
        ),
      answer: async (input: { id: string; questionNoteId: string; answers: Answer[]; message?: string }) =>
        openTask(
          await raw.tasks.answer({
            id: input.id,
            questionNoteId: input.questionNoteId,
            answers: await sealer.answers(input.id, input.answers),
            message: await sealer.note(input.id, input.message ?? ''),
          }),
        ),
      reply: async (input: { id: string; message: string; resume: boolean }) =>
        openTask(
          await raw.tasks.reply({
            id: input.id,
            message: await sealer.note(input.id, input.message),
            resume: input.resume,
          }),
        ),
      done: mutation(raw.tasks.done),
      rerun: mutation(raw.tasks.rerun),
      setPriority: mutation(raw.tasks.setPriority),
      setNotBefore: mutation(raw.tasks.setNotBefore),
      takeBack: mutation(raw.tasks.takeBack),
      setClosed: mutation(raw.tasks.setClosed),
      move: mutation(raw.tasks.move),
    },
    schedules: {
      list: async () => Promise.all((await raw.schedules.list()).map(openSchedule)),
      setPaused: async (input: { id: string; paused: boolean }) => openSchedule(await raw.schedules.setPaused(input)),
      remove: raw.schedules.remove,
    },
    machines: raw.machines,
    keys: raw.keys,
    me: raw.me,
    transcript: {
      runs: raw.transcript.runs,
      events: async (input: { runId: string; afterSeq?: number }) =>
        Promise.all(
          (await raw.transcript.events(input)).map(async ({ data, ...row }) => ({
            ...row,
            ...(await sealer.open.trData(input.runId, row.seq, data)),
          })),
        ),
      output: async (input: { runId: string; seq: number }) => {
        const output = await raw.transcript.output(input);
        return output === null ? null : sealer.open.trOutput(input.runId, input.seq, output);
      },
    },
  };
}
