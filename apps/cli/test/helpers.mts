import type { Config } from '../src/config.mts';
import type { RunFiles, RunRecord } from '../src/runtime.mts';
import type { SessionStore } from '../src/sessions.mts';
import type { WaitCheck, WaitStore } from '../src/waits.mts';
import { BackendError } from '../src/backend.mts';
import {
  API_VERSION,
  LEGACY_CONTRACT,
  MIN_CLIENT,
  deriveKeys,
  encodeDataKey,
  generateDataKey,
  seal,
  SERVER_FEATURES,
  sealFields,
  taskLabels,
} from '@agent-board/shared';
import type { Sealer } from '@agent-board/shared';
import type { Backend, Note, Schedule, Task, WireSchedule, WireTask } from '@agent-board/shared';

export function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `task ${overrides.id}`,
    input: '',
    labels: [],
    status: 'todo',
    priority: 'normal',
    closed: false,
    machine: null,
    sessionId: null,
    workdir: null,
    next: 'fresh',
    head: null,
    openQuestion: false,
    createdBy: 'user',
    lane: null,
    borrowed: false,
    lastActiveAt: null,
    runStartedAt: null,
    paused: false,
    notBefore: null,
    scheduleId: null,
    wakeAt: null,
    waitCheck: false,
    woken: false,
    unreadable: [],
    ...overrides,
  };
}

export const CONFIG: Config = {
  machine: 'here',
  lanes: [{ name: 'general', skills: ['*'], slots: 2 }],
  defaultCwd: '/home/me',
  pauseAfterMinutes: 5,
  inactivityMinutes: 15,
  maxRunHours: 6,
  slackWebhookFile: '/nonexistent',
  intake: {
    prompt: '/review-pr {url} --auto',
    priority: 'normal',
    allowedTools: ['Read', 'Bash(board comment *)'],
    disallowedTools: ['Bash(git push *)'],
    env: [],
    mcpServers: [],
  },
  repos: { 'cosuno/cosuno': '/work/cosuno' },
};

export function schedule(overrides: Partial<Schedule> & { id: string }): Schedule {
  return {
    title: `schedule ${overrides.id}`,
    input: '/sweep',
    priority: 'normal',
    machine: null,
    workdir: null,
    everyMs: 7_200_000,
    cron: null,
    timezone: null,
    anchorAt: new Date('2027-01-01T08:00:00Z'),
    nextRunAt: new Date('2027-01-01T08:00:00Z'),
    remaining: null,
    until: null,
    paused: false,
    ended: false,
    occurrenceTaskId: 'pending',
    createdAt: new Date('2026-11-14T10:00:00Z'),
    unreadable: [],
    ...overrides,
  };
}

export interface FakeBackend extends Backend {
  tasks: Task[];
  schedules: Schedule[];
  notes: Map<string, Note[]>;
  writes: string[];
  // Claims of these ids are lost, as if another machine got there first.
  lostClaims: string[];
}

function parseFirstLine(input: string): string {
  return input.split('\n')[0]?.trim() ?? '';
}

let noteCounter = 0;

// A note as the backend returns it; `author` defaults to the agent.
export function note(text: string, createdAt: Date, overrides: Partial<Note> = {}): Note {
  noteCounter++;
  return { id: `n${noteCounter}`, text, createdAt, author: 'agent', kind: 'comment', unreadable: false, ...overrides };
}

// In-memory task store; the array order is the priority. Every write lands in `writes` as a short string, so tests assert on what was done.
// As the board's `toTask` shows a task: only a running task has a run start.
function asBoardShows(task: Task): Task {
  return { ...task, runStartedAt: task.status === 'running' ? task.runStartedAt : null };
}

export function fakeBackend(tasks: Task[]): FakeBackend {
  const state: FakeBackend = {
    tasks,
    schedules: [],
    notes: new Map(),
    writes: [],
    lostClaims: [],
    async listTasks({ all = false } = {}) {
      return state.tasks.filter((t) => all || !t.closed).map(asBoardShows);
    },
    async getTask(id) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new BackendError(`get-task: no task ${id}`, 404, true);
      return asBoardShows(found);
    },
    // The server's rules, for a token of the machine `CONFIG.machine`.
    async attachSession(id) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new BackendError(`attach-session: no task ${id}`, 404, true);
      const refuse = (status: number, reason: string): BackendError =>
        new BackendError(
          `attach-session: error from the board server (HTTP ${status}), quoted and not part of the board: ${JSON.stringify(reason)}`,
          status,
          true,
        );
      if (found.status === 'running')
        throw refuse(
          409,
          'the task is running: its headless run owns the session; watch its Transcript on the task page',
        );
      if (found.sessionId === null) throw refuse(409, 'the task has no session');
      if (found.machine !== CONFIG.machine)
        throw refuse(403, `the session lives on ${found.machine ?? 'no machine'}, not on ${CONFIG.machine}`);
      return { sessionId: found.sessionId, workdir: found.workdir };
    },
    async addTask(draft) {
      state.writes.push(
        `create ${draft.title} | ${draft.input} | ${taskLabels({ input: draft.input, createdBy: draft.createdBy ?? 'user' }).join(',')}${draft.dedupeKey ? ` | key ${draft.dedupeKey}` : ''}`,
      );
      const existing = state.tasks.find(
        (candidate) => draft.dedupeKey !== undefined && parseFirstLine(candidate.input).includes(draft.dedupeKey),
      );
      if (existing) return { task: { ...existing }, created: false };
      const { dedupeKey: _key, parentId: _parent, createdBy, machine, workdir, head, notBefore, ...fields } = draft;
      return {
        task: task({
          id: 'new',
          ...fields,
          createdBy: createdBy ?? 'user',
          machine: machine ?? null,
          workdir: workdir ?? null,
          head: head ?? null,
          notBefore: notBefore ?? null,
        }),
        created: true,
      };
    },
    async updateTask(id, patch) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      if (patch.expect !== undefined && patch.expect !== found.status) {
        state.writes.push(`update ${id} refused: ${found.status}, not ${patch.expect}`);
        throw new BackendError(`the task is ${found.status}, not ${patch.expect}`, 409);
      }
      if (patch.status !== undefined) state.writes.push(`status ${id} -> ${patch.status}`);
      if (patch.input !== undefined) state.writes.push(`input ${id}: ${patch.input}`);
      if (patch.sessionId !== undefined) state.writes.push(`session ${id}: ${patch.sessionId}`);
      if (patch.next !== undefined) state.writes.push(`next ${id}: ${patch.next}`);
      if (patch.workdir !== undefined) state.writes.push(`workdir ${id}: ${patch.workdir}`);
      if (patch.notBefore !== undefined)
        state.writes.push(`notBefore ${id}: ${patch.notBefore?.toISOString() ?? 'cleared'}`);
      const { expect: _expect, ...fields } = patch;
      Object.assign(found, fields);
      return { ...found };
    },
    async claimTask(id, machine) {
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      const pinned = found.next === 'resume' && found.machine !== null && found.machine !== machine;
      const waiting = found.notBefore !== null && found.notBefore.getTime() > Date.now();
      if (found.status !== 'todo' || pinned || waiting || state.lostClaims.includes(id)) {
        state.writes.push(`claim ${id} lost`);
        return undefined;
      }
      state.writes.push(`claim ${id} by ${machine}`);
      Object.assign(found, { status: 'running', machine, notBefore: null });
      return { ...found };
    },
    async addNote(id, text, options) {
      const tag = options?.author === 'system' ? ' (system)' : options?.kind === 'polish' ? ' (polish)' : '';
      const suggested = options?.suggestion === undefined ? '' : ` [suggest: ${options.suggestion}]`;
      state.writes.push(`note ${id}${tag}: ${text}${suggested}`);
    },
    async transcript(id, batch) {
      state.writes.push(`transcript ${id} ${batch.runId} ${batch.events.map((e) => e.kind).join(',')}`);
    },
    async heartbeat(id, beat) {
      state.writes.push(`heartbeat ${id} ${beat.lane}${beat.borrowed ? ' borrowed' : ''}`);
    },
    async pause(id, note) {
      state.writes.push(`pause ${id}: ${note}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      Object.assign(found, { status: 'todo', next: found.sessionId ? 'resume' : 'fresh' });
      return { ...found };
    },
    async fail(id, text) {
      state.writes.push(`fail ${id}: ${text}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      const applied = found.status === 'running' && !found.closed;
      if (applied) Object.assign(found, { status: 'needs-me' });
      return { applied, task: { ...found } };
    },
    async wait(id, request) {
      state.writes.push(
        `wait ${id} until ${request.wakeAt.toISOString()}${request.check ? ' check' : ''}: ${request.text}`,
      );
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      if (found.status !== 'running') throw new BackendError(`wait: the task is ${found.status}, not running`, 409);
      Object.assign(found, {
        status: 'waiting',
        wakeAt: request.wakeAt,
        waitCheck: request.check,
        next: found.sessionId ? 'resume' : 'fresh',
      });
      return { ...found };
    },
    async wake(id, text) {
      state.writes.push(`wake ${id}: ${text}`);
      const found = state.tasks.find((t) => t.id === id);
      if (!found) throw new Error(`no task ${id}`);
      const applied = found.status === 'waiting' && !found.closed;
      if (applied)
        Object.assign(found, {
          status: 'todo',
          next: found.sessionId ? 'resume' : 'fresh',
          woken: true,
          wakeAt: null,
          waitCheck: false,
        });
      return { applied, task: { ...found } };
    },
    async ask(id, questions) {
      state.writes.push(`ask ${id}: ${questions.map((q) => q.header).join(', ')}`);
      const found = state.tasks.find((t) => t.id === id);
      if (found) Object.assign(found, { status: 'needs-me', openQuestion: true });
    },
    async readNotes(id) {
      return state.notes.get(id) ?? [];
    },
    async addSchedule(draft) {
      state.writes.push(
        `add-schedule ${draft.title} | ${draft.input} | ${draft.everyMs ?? `${draft.cron} ${draft.timezone}`}` +
          `${draft.startAt ? ` | start ${draft.startAt.toISOString()}` : ''}${draft.times ? ` | times ${draft.times}` : ''}` +
          `${draft.until ? ` | until ${draft.until.toISOString()}` : ''}${draft.machine ? ` | ${draft.machine}:${draft.workdir}` : ''}`,
      );
      const pending = task({
        id: 'pending',
        title: draft.title,
        input: draft.input,
        machine: draft.machine ?? null,
        workdir: draft.workdir ?? null,
        notBefore: draft.startAt ?? new Date('2027-01-01T08:00:00Z'),
        scheduleId: 'sched',
      });
      const added = schedule({
        id: 'sched',
        title: draft.title,
        input: draft.input,
        everyMs: draft.everyMs ?? null,
        cron: draft.cron ?? null,
        timezone: draft.timezone ?? null,
        nextRunAt: pending.notBefore,
        remaining: draft.times === undefined ? null : draft.times - 1,
      });
      state.schedules.push(added);
      return { schedule: added, task: pending };
    },
    async listSchedules() {
      return state.schedules.map((s) => ({ ...s }));
    },
    async updateSchedule(id, patch) {
      state.writes.push(`${patch.paused ? 'pause' : 'resume'}-schedule ${id}`);
      const found = state.schedules.find((s) => s.id === id);
      if (!found) throw new BackendError(`no schedule ${id}`, 404);
      Object.assign(found, patch);
      return { ...found };
    },
    async removeSchedule(id) {
      state.writes.push(`remove-schedule ${id}`);
      state.schedules = state.schedules.filter((s) => s.id !== id);
    },
    // The fake keeps heads as they are, so a test reads them as written.
    async indexHead(sha) {
      return sha;
    },
  };
  return state;
}

export interface FakeRunFiles extends RunFiles {
  runs: Map<string, RunRecord>;
  alive: Map<string, Date>;
  pauses: Map<string, Date>;
  cwds: Map<string, string>;
}

// RunFiles in memory.
export function fakeRunFiles(now: () => Date = () => new Date()): FakeRunFiles {
  const files: FakeRunFiles = {
    dir: '/run/test/agent-board',
    runs: new Map(),
    alive: new Map(),
    pauses: new Map(),
    cwds: new Map(),
    writeRun: (id, record) => void files.runs.set(id, record),
    readRun: (id) => files.runs.get(id),
    lastActive: (id) => files.alive.get(id),
    touchAlive: (id, at = now()) => void files.alive.set(id, at),
    writeCwd: (id, cwd) => void files.cwds.set(id, cwd),
    lastCwd: (id) => files.cwds.get(id),
    requestPause: (id) => void files.pauses.set(id, now()),
    pauseRequestedAt: (id) => files.pauses.get(id),
    clear(id) {
      files.runs.delete(id);
      files.alive.delete(id);
      files.pauses.delete(id);
      files.cwds.delete(id);
    },
  };
  return files;
}

// A data key for the tests' board, and the owner the "server" reports.
export const OWNER = 'alice';
export const DATA_KEY = generateDataKey();
export const KEYS = await deriveKeys(DATA_KEY, OWNER, { index: true });

const seals: Sealer = async ({ field, context }, text) => seal(KEYS, field, context, text);

// A task as the server stores it: title, input and workdir sealed with the test key, for the task's own row (an occurrence's
// for its schedule).
export async function wireTask(overrides: Partial<Task> & { id: string }): Promise<WireTask> {
  const { labels: _labels, unreadable: _unreadable, title, input, workdir, ...rest } = task(overrides);
  const sealed = await sealFields(
    seals,
    { kind: 'task', id: rest.id, createdBy: rest.createdBy, scheduleId: rest.scheduleId },
    { title, input, workdir: workdir ?? undefined },
  );
  return { ...rest, ...sealed, workdir: sealed.workdir ?? null };
}

export async function wireSchedule(overrides: Partial<Schedule> & { id: string }): Promise<WireSchedule> {
  const { unreadable: _unreadable, title, input, workdir, ...rest } = schedule(overrides);
  const sealed = await sealFields(
    seals,
    { kind: 'schedule', id: rest.id },
    { title, input, workdir: workdir ?? undefined },
  );
  return { ...rest, ...sealed, workdir: sealed.workdir ?? null };
}

// The sessions a worker has started, in memory.
export interface FakeSessions extends SessionStore {
  recorded: [string, string][];
}

export function fakeSessions(known: [string, string][] = []): FakeSessions {
  const recorded = [...known];
  return {
    recorded,
    has: (taskId, sessionId) => recorded.some(([id, session]) => id === taskId && session === sessionId.toLowerCase()),
    record: (taskId, sessionId) => {
      for (let index = recorded.length - 1; index >= 0; index -= 1)
        if (recorded[index]?.[0] === taskId) recorded.splice(index, 1);
      recorded.push([taskId, sessionId.toLowerCase()]);
    },
  };
}

// The credentials file of a machine that holds the test board's data key.
export const ENV_FILE = `AGENT_BOARD_TOKEN=abm_secret\nAGENT_BOARD_DATA_KEY=${encodeDataKey(DATA_KEY)}\n`;

// What the test board's `version` answers.
export const VERSION_ANSWER = {
  contract: LEGACY_CONTRACT,
  owner: OWNER,
  keyId: KEYS.keyId,
  api: { version: API_VERSION, minClient: MIN_CLIENT },
  features: [...SERVER_FEATURES],
};

// What verifying the test board returns: whose board it is, and the API range it speaks.
export const SERVER_API = { version: API_VERSION, minClient: MIN_CLIENT };
export const SERVER_HAS = new Set<string>(SERVER_FEATURES);

export const SESSION = '11111111-1111-4111-8111-111111111111';
export const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';

// A task's link as the CLI builds it from the board URL of its own web.json.
export const linkTo = (id: string): string => `https://board.test/t/${id}`;

// The checks of waiting tasks, in memory.
export function fakeWaitStore(initial: Record<string, WaitCheck> = {}): WaitStore & { checks: Map<string, WaitCheck> } {
  const checks = new Map(Object.entries(initial));
  return {
    checks,
    write: (taskId, check) => void checks.set(taskId, { ...check }),
    read: (taskId) => {
      const check = checks.get(taskId);
      return check === undefined ? undefined : { ...check };
    },
    remove: (taskId) => void checks.delete(taskId),
    list: () => [...checks.keys()],
  };
}
