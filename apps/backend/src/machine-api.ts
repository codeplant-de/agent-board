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
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config';
import type { Db, DbOrTx } from './db/client';
import { withOwner } from './db/scope';
import type { Changes } from './services/changes';
import { AppError } from './services/errors';
import { getKeys } from './services/keys';
import { machineForToken } from './services/machines';
import { addSchedule, listSchedules, removeSchedule, setPaused, toSchedule } from './services/schedules';
import { appendTranscript } from './services/transcripts';
import {
  addNote,
  addTask,
  ask,
  attachSession,
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
    case 'attach-session':
      return task(await attachSession(db, taskId(body), machine));
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
      const note = parsed(() => parseWireNoteInput(body['body'], 'note', { allowSuggestion: true }));
      const author = body['author'] === 'system' ? 'system' : 'agent';
      const kind = body['kind'] ?? 'comment';
      if (kind !== 'comment' && kind !== 'polish') throw new AppError('BAD_REQUEST', 'kind must be comment or polish');
      if (kind === 'polish' && author !== 'agent')
        throw new AppError('BAD_REQUEST', 'only an agent writes a polish note');
      await addNote(db, taskId(body), {
        author,
        kind: author === 'system' ? 'event' : kind,
        body: note.body,
        preview: note.preview ?? null,
        ...(note.suggestion === undefined ? {} : { suggestion: note.suggestion }),
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

/** The commands that change what dispatch decides; heartbeats and transcripts arrive every 15 s per running task and do not. */
const DISPATCH_WRITES = new Set([
  'add-task',
  'update-task',
  'claim-task',
  'add-note',
  'ask',
  'pause',
  'fail',
  'add-schedule',
  'update-schedule',
  'remove-schedule',
]);

export interface MachineApiOptions {
  /** How often an open event stream gets a ping and has its token checked again. */
  pingMs: number;
}

function bearerToken(req: FastifyRequest): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

async function authenticate(db: Db, req: FastifyRequest): Promise<{ identity: MachineIdentity; token: string }> {
  const token = bearerToken(req);
  const identity = token ? await machineForToken(db, token) : null;
  if (!identity) throw new AppError('UNAUTHORIZED', 'unknown or revoked machine token');
  return { identity, token };
}

export function registerMachineApi(
  app: FastifyInstance,
  db: Db,
  config: Config,
  changes: Changes,
  { pingMs }: MachineApiOptions,
): void {
  const streams = new Set<() => void>();
  // The server waits for open connections to end before it closes; these never would.
  app.addHook('preClose', async () => {
    streams.forEach((end) => end());
  });

  /** Server-sent events: a bare `tasks` event means "look at the board again"; it carries no data. */
  app.get('/api/machine/events', async (req, reply) => {
    const { identity, token } = await authenticate(db, req);
    reply.hijack();
    // The client may have left while the token was being looked up; its `close` event is gone by now.
    if (req.raw.destroyed) return;
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    const stop = changes.subscribe(identity.owner, () => res.write('event: tasks\ndata:\n\n'));
    const ping = setInterval(() => {
      res.write(': ping\n\n');
      // A revoked token must not keep a stream.
      machineForToken(db, token).then(
        (current) => {
          if (!current) end();
        },
        (err: unknown) => app.log.error({ err }, 'machine stream token check failed'),
      );
    }, pingMs);
    function end(): void {
      clearInterval(ping);
      stop();
      streams.delete(end);
      res.end();
    }
    streams.add(end);
    req.raw.on('close', end);
  });

  app.post<{ Params: { command: string } }>('/api/machine/:command', async (req) => {
    const { identity: machine } = await authenticate(db, req);
    const body = isRecord(req.body) ? req.body : {};
    const result = await withOwner(db, machine.owner, (tx) =>
      handleMachineCall(tx, config, machine, req.params.command, body),
    );
    if (DISPATCH_WRITES.has(req.params.command)) changes.notify(machine.owner);
    return { result };
  });
}
