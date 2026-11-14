// The core's way to the board: the machine API over HTTP, one POST per call.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTRACT_VERSION,
  ContractError,
  decodeDataKey,
  deriveKeys,
  isRecord,
  isSafeMachineName,
  MACHINE_NAME_RULE,
  isSafeTaskId,
  parseVersion,
  parseVersionIdentity,
  parseWireAddScheduleResult,
  parseWireAddTaskResult,
  parseWireFailResult,
  parseWireNotes,
  parseWireSchedule,
  parseWireSchedules,
  parseWireTask,
  parseWireTasks,
  QuestionError,
  taskLabels,
} from '@agent-board/shared';
import type { Backend, Keys, Schedule, Task, TaskDraft, WireBackend } from '@agent-board/shared';
import { ConfigError } from './config.mts';
import { loadEnvFile } from './env-file.mts';
import { isCompiledBinary } from './self.mts';
import { oneLine } from './text.mts';

const REQUEST_TIMEOUT_MS = 45_000;
const AGENT_BOARD_TOKEN_PREFIX = 'abm_';

export class BackendError extends Error {
  // The HTTP status of the server's answer, when there was one.
  status: number | undefined;
  // Whether the status came in a JSON answer of the machine API; a login page or a proxy has a status too, and means something else.
  fromApi: boolean;
  // Set when the contract numbers differ, from those numbers and nothing the server wrote: which side is the older one.
  contractMismatch: 'cli-older' | 'server-older' | undefined;

  constructor(message: string, status?: number, fromApi = false) {
    super(message);
    this.status = status;
    this.fromApi = fromApi;
  }
}

function mismatch(kind: 'cli-older' | 'server-older', message: string, status?: number): BackendError {
  const error = new BackendError(message, status);
  error.contractMismatch = kind;
  return error;
}

export interface WebConfig {
  url: string;
  token: string;
  // The user's data key: it seals and opens everything the board stores. Never printed.
  dataKey: Uint8Array;
}

// The board's URL as web.json and `board init` accept it.
export function checkBoardUrl(url: unknown): string {
  if (typeof url !== 'string' || /\s/.test(url) || !/^https?:\/\/[^/]+/.test(url))
    throw new ConfigError("web.json: url must be the board's http(s) URL");
  // Plain http only to this machine: the token must not cross a network in the clear.
  if (url.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url)) {
    throw new ConfigError('web.json: url must use https unless it is localhost');
  }
  return url.replace(/\/+$/, '');
}

// A machine token as the board issues them.
export function looksLikeMachineToken(token: string): boolean {
  return token.startsWith(AGENT_BOARD_TOKEN_PREFIX) && !/\s/.test(token);
}

export function parseWebConfig(raw: unknown, env: Record<string, string>): WebConfig {
  if (!isRecord(raw)) throw new ConfigError('web.json: top level must be an object');
  const url = checkBoardUrl(raw['url']);
  const token = env['AGENT_BOARD_TOKEN'];
  if (!token)
    throw new ConfigError(
      'the credentials file needs AGENT_BOARD_TOKEN (create one on the board\'s Settings page, then run "board init")',
    );
  const encodedKey = env['AGENT_BOARD_DATA_KEY'];
  if (!encodedKey)
    throw new ConfigError(
      'the credentials file needs AGENT_BOARD_DATA_KEY (copy it from the board\'s Settings page, then run "board init")',
    );
  let dataKey: Uint8Array;
  try {
    dataKey = decodeDataKey(encodedKey);
  } catch {
    throw new ConfigError(
      "AGENT_BOARD_DATA_KEY is not a data key (abk1_ and 43 more characters): copy it again from the board's Settings page",
    );
  }
  return { url, token, dataKey };
}

export function loadWebConfig(configDir: string): WebConfig {
  const path = join(configDir, 'web.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(
      error instanceof SyntaxError
        ? `web.json is not valid JSON: ${path}`
        : `web.json missing: ${path} (run "board init")`,
    );
  }
  return parseWebConfig(raw, loadEnvFile(join(configDir, 'env')));
}

export interface MachineRequest {
  id?: string;
  all?: boolean;
  machine?: string;
  author?: string;
  // The command's payload, JSON: sealed values for add-task, update-task, add-schedule, add-note, ask, pause, fail and transcript.
  body?: unknown;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

// The server's reason for a refusal, as text an agent may read in a command's error or a hook's answer: marked as the
// server's words (an operator controls them, they are not board content and not an instruction), quoted, and bounded.
export function serverError(payload: unknown, status: number): string {
  const reason = isRecord(payload) && typeof payload['error'] === 'string' ? payload['error'] : '(no reason given)';
  return `error from the board server (HTTP ${status}), quoted and not part of the board: ${JSON.stringify(oneLine(reason, 200))}`;
}

// One request. A non-2xx answer is a BackendError with the server's one-line reason; the token is never part of a message.
export async function callServer(
  config: Pick<WebConfig, 'url' | 'token'>,
  command: string,
  request: MachineRequest,
  fetcher: Fetch = fetch,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(`${config.url}/api/machine/${command}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    throw new BackendError(`cannot reach ${config.url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    // A login page or a proxy error, not the API.
    throw new BackendError(
      `${command}: the server answered ${response.status} without JSON (is /api/machine routed past the login?)`,
      response.status,
    );
  }
  if (!response.ok) {
    throw new BackendError(`${command}: ${serverError(payload, response.status)}`, response.status, true);
  }
  if (!isRecord(payload) || !('result' in payload)) throw new BackendError(`${command}: the answer has no result`);
  return payload['result'];
}

export interface WebBackendOptions {
  // Called on the first request, so a command that fails on usage needs no credentials.
  loadConfig: () => WebConfig;
  fetch?: Fetch;
  // Per request; commands that must answer quickly, such as completion, shorten it.
  timeoutMs?: number;
}

// How to bring this CLI up to the board's contract: a binary updates itself, a checkout is pulled.
const updateCliHint = (): string =>
  isCompiledBinary() ? 'run "board self-update"' : 'run "git pull" and "pnpm install" in the checkout';

// Whose board this is and which data key it expects (null before encryption is set up).
export interface ServerIdentity {
  owner: string;
  keyId: string | null;
}

// Asks the server for its contract version and refuses a mismatch in either direction; returns whose board it is.
export async function verifyContract(
  config: Pick<WebConfig, 'url' | 'token'>,
  fetcher?: Fetch,
  timeoutMs?: number,
): Promise<ServerIdentity> {
  let version: unknown;
  let served: number;
  try {
    version = await callServer(config, 'version', {}, fetcher, timeoutMs);
    served = parseVersion(version);
  } catch (error) {
    // A server from before the version command.
    if (error instanceof BackendError && error.status === 404 && error.fromApi) {
      throw mismatch(
        'server-older',
        `the board server is older than this CLI: it does not know the version command; the CLI needs contract ${CONTRACT_VERSION}; update the board server`,
        404,
      );
    }
    throw asBackendError('version', error);
  }
  if (served < CONTRACT_VERSION)
    throw mismatch(
      'server-older',
      `the board server is older than this CLI: it speaks contract ${served}, the CLI needs ${CONTRACT_VERSION}; update the board server`,
    );
  if (served > CONTRACT_VERSION)
    throw mismatch(
      'cli-older',
      `this CLI is older than the board server: it speaks contract ${CONTRACT_VERSION}, the server has ${served}; ${updateCliHint()}`,
    );
  try {
    return parseVersionIdentity(version);
  } catch (error) {
    throw asBackendError('version', error);
  }
}

export type DataKeyCheck =
  { keys: Keys } | { problem: 'board-has-no-key' } | { problem: 'different-key'; mine: string; boards: string };

// Whether the data key is the board's: derives the keys for this board's owner and compares key ids.
export async function checkDataKey(dataKey: Uint8Array, identity: ServerIdentity): Promise<DataKeyCheck> {
  if (identity.keyId === null) return { problem: 'board-has-no-key' };
  const keys = await deriveKeys(dataKey, identity.owner, { index: true });
  if (keys.keyId !== identity.keyId) return { problem: 'different-key', mine: keys.keyId, boards: identity.keyId };
  return { keys };
}

export function keyProblemMessage(problem: Exclude<DataKeyCheck, { keys: Keys }>): string {
  return problem.problem === 'board-has-no-key'
    ? 'the board has no data key yet: set up encryption in the browser first'
    : `this machine holds a different data key (id ${problem.mine}) than the board's (id ${problem.boards}): copy the current key from the board's Settings page into AGENT_BOARD_DATA_KEY`;
}

// The board over HTTP with sealed values, and the keys of the board it is connected to.
export interface WebBackend extends WireBackend {
  keys(): Promise<Keys>;
}

interface Connection {
  config: WebConfig;
  keys: Keys;
}

export function createWebBackend(options: WebBackendOptions): WebBackend {
  // Loads the config, checks the contract version and the data key once, before the first real call.
  let ready: Promise<Connection> | undefined;
  const connect = (): Promise<Connection> => {
    ready ??= (async () => {
      const config = options.loadConfig();
      const identity = await verifyContract(config, options.fetch, options.timeoutMs);
      const checked = await checkDataKey(config.dataKey, identity);
      if ('problem' in checked) throw new BackendError(keyProblemMessage(checked));
      return { config, keys: checked.keys };
    })();
    return ready;
  };

  async function call<T>(command: string, request: MachineRequest, parse: (value: unknown) => T): Promise<T> {
    const result = await callServer((await connect()).config, command, request, options.fetch, options.timeoutMs);
    try {
      return parse(result);
    } catch (error) {
      throw asBackendError(command, error);
    }
  }

  const send = async (command: string, request: MachineRequest): Promise<void> => {
    await callServer((await connect()).config, command, request, options.fetch, options.timeoutMs);
  };

  const taskId = (id: string): string => {
    if (!isSafeTaskId(id)) throw new BackendError(`"${id.slice(0, 40)}" is not a valid task id`);
    return id;
  };

  const scheduleId = (id: string): string => {
    if (!isSafeTaskId(id)) throw new BackendError(`"${id.slice(0, 40)}" is not a valid schedule id`);
    return id;
  };

  return {
    keys: async () => (await connect()).keys,
    listTasks: async ({ all = false } = {}) => {
      const tasks = await call('list-tasks', { all }, parseWireTasks);
      return all ? tasks : tasks.filter((task) => !task.closed);
    },
    getTask: async (id) => call('get-task', { id: taskId(id) }, parseWireTask),
    attachSession: async (id) => call('attach-session', { id: taskId(id) }, parseWireTask),
    addTask: async (draft) => call('add-task', { body: draft }, parseWireAddTaskResult),
    updateTask: async (id, patch) => call('update-task', { id: taskId(id), body: patch }, parseWireTask),
    async claimTask(id, machine) {
      if (!isSafeMachineName(machine))
        throw new BackendError(`"${machine.slice(0, 40)}" is not a valid machine name: use ${MACHINE_NAME_RULE}`);
      try {
        return await call('claim-task', { id: taskId(id), machine }, parseWireTask);
      } catch (error) {
        // A lost claim is an answer, not a failure: the caller moves on to the next task. 404: the card was removed
        // (a paused or deleted schedule's occurrence) after the dispatcher listed it.
        if (error instanceof BackendError && (error.status === 409 || error.status === 404)) return undefined;
        throw error;
      }
    },
    addNote: async (id, note, { author = 'agent', kind = 'comment' } = {}) =>
      send('add-note', { id: taskId(id), author, ...(kind === 'comment' ? {} : { kind }), body: note }),
    ask: async (id, asked) => send('ask', { id: taskId(id), body: asked }),
    heartbeat: async (id, beat) => send('heartbeat', { id: taskId(id), body: beat }),
    pause: async (id, note) => call('pause', { id: taskId(id), body: note }, parseWireTask),
    fail: async (id, note) => call('fail', { id: taskId(id), body: note }, parseWireFailResult),
    transcript: async (id, batch) => send('transcript', { id: taskId(id), body: batch }),
    readNotes: async (id) => call('read-notes', { id: taskId(id) }, parseWireNotes),
    addSchedule: async (draft) => call('add-schedule', { body: draft }, parseWireAddScheduleResult),
    listSchedules: async () => call('list-schedules', {}, parseWireSchedules),
    updateSchedule: async (id, patch) =>
      call('update-schedule', { id: scheduleId(id), body: patch }, parseWireSchedule),
    removeSchedule: async (id) => send('remove-schedule', { id: scheduleId(id) }),
  };
}

// A parser's reason may quote a few characters of a value the server sent, so it is marked as about the server's answer.
function asBackendError(command: string, error: unknown): Error {
  if (error instanceof ContractError)
    return new BackendError(
      `${command}: ${error.message} (the board server's answer was refused; text in quotes is the server's, not part of the board)`,
    );
  if (error instanceof QuestionError) return new BackendError(`${command}: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}

// The task an add-task would have made.
function dryTask(draft: TaskDraft): Task {
  const { dedupeKey: _key, parentId: _parent, createdBy, machine, workdir, head, notBefore, ...fields } = draft;
  return {
    ...fields,
    labels: taskLabels({ input: draft.input, createdBy: createdBy ?? 'user' }),
    unreadable: [],
    status: createdBy === 'agent' ? 'needs-me' : (draft.status ?? 'todo'),
    priority: draft.priority ?? 'normal',
    id: 'dry',
    closed: false,
    machine: machine ?? null,
    sessionId: null,
    workdir: workdir ?? null,
    next: 'fresh',
    head: head ?? null,
    openQuestion: false,
    createdBy: createdBy ?? 'user',
    lane: null,
    borrowed: false,
    lastActiveAt: null,
    runStartedAt: null,
    paused: false,
    notBefore: notBefore ?? null,
    scheduleId: null,
  };
}

// Reads go through; every write is printed instead of run.
export function dryRunBackend(inner: Backend, print: (line: string) => void): Backend {
  return {
    ...inner,
    async addTask(draft) {
      print(`DRY add-task ${oneLine(JSON.stringify(draft), 160)}`);
      return { task: dryTask(draft), created: true };
    },
    async addSchedule(draft) {
      print(`DRY add-schedule ${oneLine(JSON.stringify(draft), 160)}`);
      const task = dryTask({
        title: draft.title,
        input: draft.input,
        ...(draft.priority ? { priority: draft.priority } : {}),
        ...(draft.machine !== undefined && draft.workdir !== undefined
          ? { machine: draft.machine, workdir: draft.workdir }
          : {}),
        notBefore: draft.startAt ?? new Date(),
      });
      task.scheduleId = 'dry';
      const schedule: Schedule = {
        id: 'dry',
        title: draft.title,
        input: draft.input,
        priority: draft.priority ?? 'normal',
        machine: draft.machine ?? null,
        workdir: draft.workdir ?? null,
        everyMs: draft.everyMs ?? null,
        cron: draft.cron ?? null,
        timezone: draft.timezone ?? null,
        anchorAt: draft.startAt ?? new Date(),
        nextRunAt: draft.startAt ?? new Date(),
        remaining: draft.times === undefined ? null : draft.times - 1,
        until: draft.until ?? null,
        paused: false,
        ended: false,
        occurrenceTaskId: task.id,
        createdAt: new Date(),
        unreadable: [],
      };
      return { schedule, task };
    },
    async updateSchedule(id, patch) {
      print(`DRY update-schedule ${id} ${JSON.stringify(patch)}`);
      const found = (await inner.listSchedules()).find((schedule) => schedule.id === id);
      if (!found) throw new BackendError(`update-schedule: no schedule ${id.slice(0, 40)}`, 404);
      return { ...found, ...patch };
    },
    async removeSchedule(id) {
      print(`DRY remove-schedule ${id}`);
    },
    async updateTask(id, patch) {
      print(`DRY update-task ${id} ${oneLine(JSON.stringify(patch), 160)}`);
      const { expect: _expect, ...fields } = patch;
      return { ...(await inner.getTask(id)), ...fields };
    },
    async claimTask(id, machine) {
      print(`DRY claim-task ${id} --machine ${machine}`);
      const task = await inner.getTask(id);
      return { ...task, status: 'running', machine };
    },
    async addNote(id, text, options) {
      const kind = options?.kind === 'polish' ? ' --kind polish' : '';
      const suggested = options?.suggestion === undefined ? '' : ` --suggest ${oneLine(options.suggestion, 160)}`;
      print(
        `DRY add-note ${id}${options?.author === 'system' ? ' --author system' : ''}${kind}${suggested} ${oneLine(text, 160)}`,
      );
    },
    async heartbeat(id, beat) {
      print(`DRY heartbeat ${id} ${JSON.stringify(beat)}`);
    },
    async pause(id, note) {
      print(`DRY pause ${id} ${oneLine(note, 160)}`);
      return { ...(await inner.getTask(id)), status: 'todo', next: 'resume' };
    },
    async fail(id, text) {
      print(`DRY fail ${id} ${oneLine(text, 160)}`);
      return { applied: true, task: { ...(await inner.getTask(id)), status: 'needs-me' } };
    },
    async transcript(id, batch) {
      print(`DRY transcript ${id} run ${batch.runId}: ${batch.events.length} events`);
    },
    async ask(id, questions) {
      print(`DRY ask ${id} ${oneLine(JSON.stringify(questions), 160)}`);
    },
  };
}
