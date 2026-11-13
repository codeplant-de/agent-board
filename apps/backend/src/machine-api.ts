/**
 * The backend contract over HTTP, for bin/web-backend on the worker machines: POST /api/machine/<subcommand>
 * with a bearer token. The body carries the subcommand's arguments and stdin; the answer is {result} or {error}.
 */
import {
  ContractError,
  isRecord,
  isSafeMachineName,
  isSafeTaskId,
  parseDraft,
  parsePatch,
  parseQuestions,
  parseSetupRequest,
  QuestionError,
  serializeNote,
} from '@agent-board/shared';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/client';
import { AppError } from './services/errors';
import { machineForToken } from './services/machines';
import {
  addNote,
  addTask,
  ask,
  claimTask,
  getTask,
  listTasks,
  readNotes,
  setupLabels,
  toNote,
  toTask,
  updateTask,
} from './services/tasks';

function taskId(body: Record<string, unknown>): string {
  const id = body['id'];
  if (typeof id !== 'string' || !isSafeTaskId(id)) throw new AppError('BAD_REQUEST', 'a valid task id is required');
  return id;
}

/** Contract and question errors are the caller's fault: 400 with the parser's reason. */
function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ContractError || error instanceof QuestionError)
      throw new AppError('BAD_REQUEST', error.message);
    throw error;
  }
}

export async function handleMachineCall(
  db: Db,
  config: Config,
  machine: string,
  command: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const task = (row: Parameters<typeof toTask>[0]) => toTask(row, config.publicUrl);
  switch (command) {
    case 'list-tasks':
      return (await listTasks(db, { all: body['all'] === true })).map(task);
    case 'get-task':
      return task(await getTask(db, taskId(body)));
    case 'add-task': {
      const draft = parsed(() => parseDraft(body['body']));
      const { row, created } = await addTask(db, draft);
      return { task: task(row), created };
    }
    case 'update-task':
      return task(await updateTask(db, taskId(body), parsed(() => parsePatch(body['body']))));
    case 'claim-task': {
      const id = taskId(body);
      const asMachine = body['machine'];
      if (typeof asMachine !== 'string' || !isSafeMachineName(asMachine))
        throw new AppError('BAD_REQUEST', 'machine is required');
      // A token claims for its own machine only.
      if (asMachine !== machine)
        throw new AppError('FORBIDDEN', `this token belongs to ${machine}, not ${asMachine}`);
      const row = await claimTask(db, id, machine);
      if (!row) throw new AppError('CONFLICT', 'the task is not free for this machine');
      return task(row);
    }
    case 'add-note': {
      const text = body['body'];
      if (typeof text !== 'string' || text.trim() === '') throw new AppError('BAD_REQUEST', 'note text is empty');
      const author = body['author'] === 'system' ? 'system' : 'agent';
      await addNote(db, taskId(body), { author, kind: author === 'system' ? 'event' : 'comment', body: text, by: machine });
      return null;
    }
    case 'ask': {
      const questions = parsed(() => parseQuestions(body['body']));
      await ask(db, taskId(body), questions, machine);
      return null;
    }
    case 'read-notes':
      return (await readNotes(db, taskId(body))).map((row) => serializeNote(toNote(row)));
    case 'setup': {
      const names = parsed(() => parseSetupRequest(body['body']));
      return { created: await setupLabels(db, names, body['dryRun'] === true) };
    }
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
    return { result: await handleMachineCall(db, config, machine, req.params.command, body) };
  });
}
