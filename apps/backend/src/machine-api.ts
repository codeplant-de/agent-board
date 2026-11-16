/**
 * The machine API, for the CLI on the worker machines: POST /api/machine/<command> with a bearer token.
 * The body carries the command's arguments; the answer is {result} or {error}.
 */
import {
  API_VERSION,
  CLIENT_API_HEADER,
  CLIENT_FEATURES_HEADER,
  CLIENT_VERSION_HEADER,
  ContractError,
  findUnknownVocabulary,
  isRecord,
  isSafeMachineName,
  isSafeTaskId,
  LEGACY_CONTRACT,
  MIN_CLIENT,
  parseClientApi,
  parseAckMessages,
  parseClientFeatures,
  parseClientVersion,
  parseHeartbeat,
  parseSchedulePatch,
  parseWireAsk,
  parseWireDirs,
  parseWireNoteInput,
  parseWirePr,
  parseWirePrState,
  parseWireScheduleDraft,
  parseWireTaskDraft,
  parseWireTaskPatch,
  parseWireTranscriptBatch,
  parseWireWait,
  TranscriptError,
  SERVER_FEATURES,
  serializeSchedule,
  serializeWireNote,
} from '@agent-board/shared';
import type { VocabularyFeatures, VocabularyItem } from '@agent-board/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config';
import type { Db, DbOrTx } from './db/client';
import { withOwner } from './db/scope';
import type { Changes } from './services/changes';
import { AppError } from './services/errors';
import { getKeys } from './services/keys';
import { machineDirsIndex, machineForToken, recordClient, setMachineDirs } from './services/machines';
import { addSchedule, listSchedules, removeSchedule, setPaused, toSchedule } from './services/schedules';
import { appendTranscript } from './services/transcripts';
import {
  ackMessages,
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
  runInbox,
  setPr,
  setPrState,
  stopped,
  toNote,
  toTask,
  updateTask,
  wait,
  wake,
} from './services/tasks';

function idOf(body: Record<string, unknown>, what: 'task' | 'schedule'): string {
  const id = body['id'];
  if (typeof id !== 'string' || !isSafeTaskId(id)) throw new AppError('BAD_REQUEST', `a valid ${what} id is required`);
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

declare module 'fastify' {
  interface FastifyRequest {
    /** The machine behind the bearer token of a /api/machine/* request, set before the body is read. */
    machineAuth: { identity: MachineIdentity; token: string } | null;
  }
}

/** Plenty for every command but `transcript`: the largest sealed fields (a task's input, a note's body) are about 1 MiB as envelopes. */
const MACHINE_BODY_LIMIT = 2 * 1024 * 1024;
/** A transcript batch can carry a few large tool results. */
const TRANSCRIPT_BODY_LIMIT = 16 * 1024 * 1024;

/** What a client that sent these features can be shown: an item with an enum value it has no feature for is left out. */
function knownTo(clientFeatures: ReadonlySet<string>, vocabulary: VocabularyFeatures | undefined) {
  const unknownTo = (item: VocabularyItem) => findUnknownVocabulary(item, clientFeatures, vocabulary);
  return {
    /** A list leaves out what the client cannot read. */
    only: <T extends VocabularyItem>(items: T[]): T[] => items.filter((item) => unknownTo(item) === undefined),
    /** A single object the client cannot read is a refusal, and the write behind it rolls back with the request. */
    one: <T extends VocabularyItem>(item: T, what: 'task' | 'schedule'): T => {
      const unknown = unknownTo(item);
      if (unknown !== undefined)
        throw new AppError(
          'UNPROCESSABLE',
          `this ${what} uses ${unknown.field} ${JSON.stringify(unknown.value)}, which this CLI does not know; update the CLI`,
        );
      return item;
    },
  };
}

async function handleMachineCall(
  db: DbOrTx,
  config: Config,
  identity: MachineIdentity,
  command: string,
  body: Record<string, unknown>,
  client: { features: ReadonlySet<string>; vocabulary?: VocabularyFeatures } = { features: new Set() },
): Promise<unknown> {
  const machine = identity.name;
  const visible = knownTo(client.features, client.vocabulary);
  const task = (row: Parameters<typeof toTask>[0]) => visible.one(toTask(row), 'task');
  const schedule = (row: Parameters<typeof toSchedule>[0]) => visible.one(toSchedule(row), 'schedule');
  switch (command) {
    case 'version':
      return {
        // A CLI up to 0.7.0 compares this exactly: once a break raises MIN_CLIENT above it, it must stop those CLIs too.
        contract: Math.max(LEGACY_CONTRACT, MIN_CLIENT),
        owner: identity.owner,
        keyId: (await getKeys(db))?.keyId ?? null,
        api: { version: API_VERSION, minClient: MIN_CLIENT },
        features: SERVER_FEATURES,
        dirsIndex: await machineDirsIndex(db, machine),
        ...(config.cliVersion === null ? {} : { cli: config.cliVersion }),
      };
    case 'list-tasks':
      return visible.only((await listTasks(db, { all: body['all'] === true })).map(toTask));
    case 'get-task':
      return task(await getTask(db, idOf(body, 'task')));
    case 'attach-session':
      return task(await attachSession(db, idOf(body, 'task'), machine));
    case 'add-task': {
      const draft = parsed(() => parseWireTaskDraft(body['body']));
      const { row, created } = await addTask(db, draft);
      return { task: task(row), created };
    }
    case 'update-task':
      return task(
        await updateTask(
          db,
          idOf(body, 'task'),
          parsed(() => parseWireTaskPatch(body['body'])),
        ),
      );
    case 'claim-task': {
      const id = idOf(body, 'task');
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
      await addNote(db, idOf(body, 'task'), {
        author,
        kind: author === 'system' ? 'event' : kind,
        body: note.body,
        preview: note.preview ?? null,
        ...(note.suggestion === undefined ? {} : { suggestion: note.suggestion }),
        by: machine,
      });
      return null;
    }
    case 'set-pr': {
      const { pr } = parsed(() => parseWirePr(body['body']));
      await setPr(db, idOf(body, 'task'), pr);
      return null;
    }
    case 'set-pr-state': {
      const { prState } = parsed(() => parseWirePrState(body['body']));
      await setPrState(db, idOf(body, 'task'), prState);
      return null;
    }
    case 'set-dirs':
      await setMachineDirs(
        db,
        machine,
        parsed(() => parseWireDirs(body['body'])),
      );
      return null;
    case 'ask': {
      const asked = parsed(() => parseWireAsk(body['body']));
      await ask(db, idOf(body, 'task'), asked, machine);
      return null;
    }
    case 'heartbeat':
      await heartbeat(
        db,
        idOf(body, 'task'),
        parsed(() => parseHeartbeat(body['body'])),
        machine,
      );
      return null;
    case 'pause': {
      const note = parsed(() => parseWireNoteInput(body['body'], 'pause note'));
      return task(await pause(db, idOf(body, 'task'), note, machine));
    }
    case 'fail': {
      const note = parsed(() => parseWireNoteInput(body['body'], 'fail note'));
      const { applied, row } = await failTask(db, idOf(body, 'task'), note, machine);
      return { applied, task: task(row) };
    }
    case 'wait': {
      const request = parsed(() => parseWireWait(body['body']));
      return task(await wait(db, idOf(body, 'task'), request, machine));
    }
    case 'wake': {
      const note = parsed(() => parseWireNoteInput(body['body'], 'wake note'));
      const { applied, row } = await wake(db, idOf(body, 'task'), note, machine);
      return { applied, task: task(row) };
    }
    case 'run-inbox': {
      const inbox = await runInbox(db, idOf(body, 'task'), machine);
      return {
        stop: inbox.stop,
        ...(inbox.stopMessage === undefined ? {} : { stopMessage: inbox.stopMessage }),
        messages: visible.only(inbox.messages.map(toNote)).map(serializeWireNote),
      };
    }
    case 'ack-messages': {
      const ack = parsed(() => parseAckMessages(body['body']));
      await ackMessages(db, idOf(body, 'task'), { ids: ack.ids, stop: ack.stop === true }, machine);
      return null;
    }
    case 'stopped': {
      const note = parsed(() => parseWireNoteInput(body['body'], 'stopped note'));
      return task(await stopped(db, idOf(body, 'task'), note, machine));
    }
    case 'transcript':
      await appendTranscript(
        db,
        idOf(body, 'task'),
        machine,
        parsed(() => parseWireTranscriptBatch(body['body'])),
      );
      return null;
    case 'read-notes':
      return visible.only((await readNotes(db, idOf(body, 'task'))).map(toNote)).map(serializeWireNote);
    case 'add-schedule': {
      const draft = parsed(() => parseWireScheduleDraft(body['body']));
      const { schedule: created, task: pending } = await addSchedule(db, draft);
      return { schedule: serializeSchedule(schedule(created)), task: task(pending) };
    }
    case 'list-schedules':
      return visible.only((await listSchedules(db)).map(toSchedule)).map(serializeSchedule);
    case 'update-schedule': {
      const { paused } = parsed(() => parseSchedulePatch(body['body']));
      return serializeSchedule(schedule(await setPaused(db, idOf(body, 'schedule'), paused)));
    }
    case 'remove-schedule':
      await removeSchedule(db, idOf(body, 'schedule'));
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
  'set-pr',
  'ask',
  'pause',
  'stopped',
  'fail',
  'wait',
  'wake',
  'add-schedule',
  'update-schedule',
  'remove-schedule',
]);

export interface MachineApiOptions {
  /** How often an open event stream gets a ping and has its token checked again. */
  pingMs: number;
  /** Which client feature each enum value needs; tests hand in a table with a value added after the baseline. */
  vocabulary?: VocabularyFeatures;
}

function bearerToken(req: FastifyRequest): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
}

/** A header sent once; a repeated one is ignored along with anything malformed. */
function headerValue(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

async function authenticate(db: Db, req: FastifyRequest): Promise<{ identity: MachineIdentity; token: string }> {
  const token = bearerToken(req);
  const identity = token ? await machineForToken(db, token) : null;
  if (!identity) throw new AppError('UNAUTHORIZED', 'unknown or revoked machine token');
  return { identity, token };
}

/** The identity `authenticate` put on the request; a route outside the authenticated scope has none, which is a bug. */
function authOf(req: FastifyRequest): { identity: MachineIdentity; token: string } {
  if (!req.machineAuth) throw new AppError('UNAUTHORIZED', 'unknown or revoked machine token');
  return req.machineAuth;
}

export function registerMachineApi(
  app: FastifyInstance,
  db: Db,
  config: Config,
  changes: Changes,
  { pingMs, vocabulary }: MachineApiOptions,
): void {
  const streams = new Set<() => void>();
  // The server waits for open connections to end before it closes; these never would.
  app.addHook('preClose', async () => {
    streams.forEach((end) => end());
  });
  app.decorateRequest('machineAuth', null);

  // Its own scope under the prefix, so the token check runs in onRequest for every URL and method there, unmatched ones
  // included: before Fastify reads and parses the body, which an unauthenticated caller must not be able to make it buffer.
  void app.register(
    async (machineApp) => {
      machineApp.addHook('onRequest', async (req) => {
        req.machineAuth = await authenticate(db, req);
      });
      machineApp.setNotFoundHandler(async (req) => {
        throw new AppError('NOT_FOUND', `unknown route ${req.method} ${req.url.slice(0, 40)}`);
      });
      registerRoutes(machineApp);
    },
    { prefix: '/api/machine' },
  );

  function registerRoutes(app: FastifyInstance): void {
    /** Server-sent events: a bare `tasks` event means "look at the board again"; it carries no data. */
    app.get('/events', async (req, reply) => {
      const { identity, token } = authOf(req);
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

    async function serve(req: FastifyRequest, command: string): Promise<{ result: unknown }> {
      const { identity: machine } = authOf(req);
      const body = isRecord(req.body) ? req.body : {};
      const result = await withOwner(db, machine.owner, async (tx) => {
        // Only `version`, which every CLI process sends first: a worker that started before an update keeps sending
        // heartbeats from the old binary, and those must not make the machine look outdated again.
        if (command === 'version')
          await recordClient(tx, machine.name, {
            version: parseClientVersion(headerValue(req, CLIENT_VERSION_HEADER)),
            api: parseClientApi(headerValue(req, CLIENT_API_HEADER)),
          });
        return handleMachineCall(tx, config, machine, command, body, {
          features: parseClientFeatures(req.headers[CLIENT_FEATURES_HEADER]),
          ...(vocabulary === undefined ? {} : { vocabulary }),
        });
      });
      if (DISPATCH_WRITES.has(command)) changes.notify(machine.owner);
      return { result };
    }

    // `transcript` is its own route so that it alone takes a large body; the others share one route and a small limit.
    app.post('/transcript', { bodyLimit: TRANSCRIPT_BODY_LIMIT }, (req) => serve(req, 'transcript'));
    app.post<{ Params: { command: string } }>('/:command', { bodyLimit: MACHINE_BODY_LIMIT }, (req) =>
      serve(req, req.params.command),
    );
  }
}
