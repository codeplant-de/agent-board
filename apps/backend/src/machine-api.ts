/**
 * The machine API, for the CLI on the worker machines: POST /api/machine/<command> with a bearer token.
 * The body carries the command's arguments; the answer is {result} or {error}.
 */
import {
  CONTRACT_VERSION,
  ContractError,
  isRecord,
  isSafeMachineName,
  isSafeTaskId,
  parseHeartbeat,
  parseSchedulePatch,
  parseWireAsk,
  parseWireNoteInput,
  parseWireScheduleDraft,
  parseWireTaskDraft,
  parseWireTaskPatch,
  parseWireTranscriptBatch,
  TranscriptError,
  serializeSchedule,
  serializeWireNote,
} from '@agent-board/shared';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config';
import type { Db, DbOrTx } from './db/client';
import { withOwner } from './db/scope';
import { AppError } from './services/errors';
import { getKeys } from './services/keys';
import { machineForToken } from './services/machines';
import { addSchedule, listSchedules, removeSchedule, setPaused, toSchedule } from './services/schedules';
import { appendTranscript } from './services/transcripts';
import {
  addNote,
  addTask,
  ask,
  claimTask,
  failTask,
  getTask,
  heartbeat,
  listTasks,
  pause,
  readNotes,
  toNote,
  toTask,
  updateTask,
} from './services/tasks';

function scheduleId(body: Record<string, unknown>): string {
  const id = body['id'];
  if (typeof id !== 'string' || !isSafeTaskId(id)) throw new AppError('BAD_REQUEST', 'a valid schedule id is required');
  return id;
}

function taskId(body: Record<string, unknown>): string {
  const id = body['id'];
  if (typeof id !== 'string' || !isSafeTaskId(id)) throw new AppError('BAD_REQUEST', 'a valid task id is required');
  return id;
}

/** Contract and transcript errors are the caller's fault: 400 with the parser's reason. */
function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ContractError || error instanceof TranscriptError)
      throw new AppError('BAD_REQUEST', error.message);
    throw error;
  }
}

type MachineIdentity = NonNullable<Awaited<ReturnType<typeof machineForToken>>>;

export async function handleMachineCall(
  db: DbOrTx,
  config: Config,
  identity: MachineIdentity,
  command: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const machine = identity.name;
  const task = toTask;
  switch (command) {
    case 'version':
      return { contract: CONTRACT_VERSION, owner: identity.owner, keyId: (await getKeys(db))?.keyId ?? null };
    case 'list-tasks':
      return (await listTasks(db, { all: body['all'] === true })).map(task);
    case 'get-task':
      return task(await getTask(db, taskId(body)));
    case 'add-task': {
      const draft = parsed(() => parseWireTaskDraft(body['body']));
      const { row, created } = await addTask(db, draft);
      return { task: task(row), created };
    }
    case 'update-task':
      return task(
        await updateTask(
          db,
          taskId(body),
          parsed(() => parseWireTaskPatch(body['body'])),
        ),
      );
    case 'claim-task': {
      const id = taskId(body);
      const asMachine = body['machine'];
      if (typeof asMachine !== 'string' || !isSafeMachineName(asMachine))
        throw new AppError('BAD_REQUEST', 'machine is required');
      // A token claims for its own machine only.
      if (asMachine !== machine) throw new AppError('FORBIDDEN', `this token belongs to ${machine}, not ${asMachine}`);
      const row = await claimTask(db, id, machine);
      if (!row) throw new AppError('CONFLICT', 'the task is not free for this machine');
      return task(row);
    }
    case 'add-note': {
      const note = parsed(() => parseWireNoteInput(body['body'], 'note'));
      const author = body['author'] === 'system' ? 'system' : 'agent';
      await addNote(db, taskId(body), {
        author,
        kind: author === 'system' ? 'event' : 'comment',
        body: note.body,
        preview: note.preview ?? null,
        by: machine,
      });
      return null;
    }
    case 'ask': {
      const asked = parsed(() => parseWireAsk(body['body']));
      await ask(db, taskId(body), asked, machine);
      return null;
    }
    case 'heartbeat':
      await heartbeat(
        db,
        taskId(body),
        parsed(() => parseHeartbeat(body['body'])),
      );
      return null;
    case 'pause': {
      const note = parsed(() => parseWireNoteInput(body['body'], 'pause note'));
      return task(await pause(db, taskId(body), note, machine));
    }
    case 'fail': {
      const note = parsed(() => parseWireNoteInput(body['body'], 'fail note'));
      const { applied, row } = await failTask(db, taskId(body), note, machine);
      return { applied, task: task(row) };
    }
    case 'transcript':
      await appendTranscript(
        db,
        taskId(body),
        machine,
        parsed(() => parseWireTranscriptBatch(body['body'])),
      );
      return null;
    case 'read-notes':
      return (await readNotes(db, taskId(body))).map((row) => serializeWireNote(toNote(row)));
    case 'add-schedule': {
      const draft = parsed(() => parseWireScheduleDraft(body['body']));
      const { schedule, task: pending } = await addSchedule(db, draft);
      return { schedule: serializeSchedule(toSchedule(schedule)), task: task(pending) };
    }
    case 'list-schedules':
      return (await listSchedules(db)).map((row) => serializeSchedule(toSchedule(row)));
    case 'update-schedule': {
      const { paused } = parsed(() => parseSchedulePatch(body['body']));
      return serializeSchedule(toSchedule(await setPaused(db, scheduleId(body), paused)));
    }
    case 'remove-schedule':
      await removeSchedule(db, scheduleId(body));
      return null;
    default:
      throw new AppError('NOT_FOUND', `unknown command ${command.slice(0, 40)}`);
  }
}

export function registerMachineApi(app: FastifyInstance, db: Db, config: Config): void {
  app.post<{ Params: { command: string } }>('/api/machine/:command', async (req) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const machine = token ? await machineForToken(db, token) : null;
    if (!machine) throw new AppError('UNAUTHORIZED', 'unknown or revoked machine token');
    const body = isRecord(req.body) ? req.body : {};
    return {
      result: await withOwner(db, machine.owner, (tx) =>
        handleMachineCall(tx, config, machine, req.params.command, body),
      ),
    };
  });
}
