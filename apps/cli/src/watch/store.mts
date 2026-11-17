// The watches of tasks on this machine, and what they reported. A watch belongs to a task, has a name and a source, and its events
// reach the agent as text. All state is on disk, so the watch unit, the dispatcher's tick, the worker and the `board` commands
// (separate processes) agree through these files alone:
//   <state dir>/watches/                  mode 700
//     .heartbeat                          touched by the watch unit on every scan; its mtime is the heartbeat
//     <task>/                             mode 700
//       watch-<name>.json                 one watch and its last attempt, mode 600
//       event-<epochMs>-<name>.json       one event the agent has not been handed yet (the spool), mode 600
//       live                              the pid of the worker running the task, there from its start to its end
// Writes are atomic. Finishing a watch is a claim by rename: only the process whose rename succeeded writes the event, so the
// unit, the tick and `board unwatch` cannot produce one twice.
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isRecord, isSafeTaskId, isSafeWorkdir } from '@agent-board/shared';
import { getPaths } from '../config/config.mts';
import { requireTaskId } from '../task-id.mts';
import { sanitizeEventText } from './fence.mts';
import { isPrUrl, isWatchName } from './shapes.mts';

export { isPrUrl, isWatchName } from './shapes.mts';

const COMMIT = /^[0-9a-f]{40}$/;
const WATCH_ID = /^[A-Za-z0-9-]{8,64}$/;
export const MAX_COMMAND_CHARS = 8000;

export const DEFAULT_TIMEOUT_MS = 2 * 60 * 60_000;
export const CI_EVERY_MS = 30_000;
export const MIN_COMMAND_EVERY_MS = 15_000;

export type WatchSource =
  | {
      kind: 'ci';
      // The PR URL as gh prints it.
      pr: string;
      required: boolean;
      // The commit being watched, and when this commit was first seen (or the watch registered).
      head?: string;
      headSince?: string;
      cwd: string;
      settingsDir?: string;
    }
  | {
      kind: 'command';
      // A shell command (bash -c); exit 0 ends the watch.
      command: string;
      cwd: string;
      // Whose `.claude` settings give the command their `env` (see WaitCheck.settingsDir).
      settingsDir?: string;
    }
  | { kind: 'timer' };

export interface WatchDef {
  // Random per watch: a replaced or removed watch is not brought back by a late write of the old one.
  id: string;
  name: string;
  task: string;
  source: WatchSource;
  // 0 for a timer, which is not polled.
  everyMs: number;
  createdAt: string;
  // A timer's end; any other watch's timeout.
  deadline: string;
  // The last attempt: when it ended and a one-line state (ci: "3 of 7 passed, 4 running", command: exit code and the end of its output).
  last?: { at: string; summary: string };
}

export interface WatchEvent {
  id: string;
  task: string;
  name: string;
  // ISO time.
  at: string;
  kind: 'event' | 'timeout';
  // Already sanitized (see fence.mts).
  text: string;
  // ISO time of the last wake the unit tried for this event.
  wakeTriedAt?: string;
}

export interface StoredEvent {
  // The file name in the task's folder, which `deleteEvents` takes.
  file: string;
  event: WatchEvent;
}

export interface WatchList {
  defs: WatchDef[];
  // File names that could not be read, for the caller to log.
  unreadable: string[];
}

// A watch this process took off the store by rename. `done` removes the claimed file once the event is written.
export interface Claim {
  def: WatchDef;
  done: () => void;
}

export interface WatchStore {
  // Task ids with a folder here.
  tasks: () => string[];
  list: (task: string) => WatchList;
  read: (task: string, name: string) => WatchDef | undefined;
  // Creates or replaces the watch of that name.
  write: (def: WatchDef) => void;
  // Rewrites the watch only if it still exists with the same id; false otherwise.
  update: (def: WatchDef) => boolean;
  // Takes the watch away for finishing; undefined when it is gone already or `id` is not its id.
  claim: (task: string, name: string, id?: string) => Claim | undefined;
  // The open watches of every task.
  all: () => WatchDef[];
  events: (task: string) => StoredEvent[];
  writeEvent: (event: WatchEvent) => string;
  // Rewrites an event that is still in the spool.
  updateEvent: (task: string, stored: StoredEvent) => void;
  // Deletes exactly these files; an event that arrived meanwhile stays.
  deleteEvents: (task: string, files: string[]) => void;
  touchHeartbeat: (at: Date) => void;
  heartbeatAt: () => Date | undefined;
  markLive: (task: string, pid: number) => void;
  clearLive: (task: string) => void;
  livePid: (task: string) => number | undefined;
  // The whole folder of the task: watches, spool and live marker.
  dropTask: (task: string) => void;
}

function atomicWrite(file: string, content: string): void {
  const temp = `${file}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, file);
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function optionalSettingsDir(raw: Record<string, unknown>): { settingsDir?: string } {
  const { settingsDir } = raw;
  return typeof settingsDir === 'string' && isSafeWorkdir(settingsDir) ? { settingsDir } : {};
}

function parseSource(raw: unknown): WatchSource | undefined {
  if (!isRecord(raw)) return undefined;
  const { kind, cwd } = raw;
  if (kind === 'timer') return { kind };
  if (typeof cwd !== 'string' || !isSafeWorkdir(cwd)) return undefined;
  if (kind === 'command') {
    const { command } = raw;
    if (typeof command !== 'string' || command.trim() === '' || command.length > MAX_COMMAND_CHARS) return undefined;
    return { kind, command, cwd, ...optionalSettingsDir(raw) };
  }
  if (kind === 'ci') {
    const { pr, required, head, headSince } = raw;
    if (typeof pr !== 'string' || !isPrUrl(pr) || typeof required !== 'boolean') return undefined;
    return {
      kind,
      pr,
      required,
      cwd,
      ...(typeof head === 'string' && COMMIT.test(head) ? { head } : {}),
      ...(isIso(headSince) ? { headSince } : {}),
      ...optionalSettingsDir(raw),
    };
  }
  return undefined;
}

/** A watch as stored, or undefined when anything about it is not the shape this CLI writes. */
export function parseWatchDef(raw: unknown): WatchDef | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, name, task, source, everyMs, createdAt, deadline, last } = raw;
  if (typeof id !== 'string' || !WATCH_ID.test(id)) return undefined;
  if (typeof name !== 'string' || !isWatchName(name)) return undefined;
  if (typeof task !== 'string' || !isSafeTaskId(task)) return undefined;
  const parsed = parseSource(source);
  if (parsed === undefined) return undefined;
  if (typeof everyMs !== 'number' || !Number.isFinite(everyMs) || everyMs < 0) return undefined;
  if (parsed.kind !== 'timer' && everyMs <= 0) return undefined;
  if (!isIso(createdAt) || !isIso(deadline)) return undefined;
  const def: WatchDef = { id, name, task, source: parsed, everyMs, createdAt, deadline };
  if (isRecord(last) && isIso(last['at']) && typeof last['summary'] === 'string')
    def.last = { at: last['at'], summary: last['summary'] };
  return def;
}

/** An event as stored, with its text sanitized again, or undefined when anything about it is not the shape this CLI writes. */
export function parseWatchEvent(raw: unknown): WatchEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, task, name, at, kind, text, wakeTriedAt } = raw;
  if (typeof id !== 'string' || !WATCH_ID.test(id)) return undefined;
  if (typeof task !== 'string' || !isSafeTaskId(task)) return undefined;
  if (typeof name !== 'string' || !isWatchName(name)) return undefined;
  if (!isIso(at) || (kind !== 'event' && kind !== 'timeout') || typeof text !== 'string') return undefined;
  return {
    id,
    task,
    name,
    at,
    kind,
    text: sanitizeEventText(text),
    ...(isIso(wakeTriedAt) ? { wakeTriedAt } : {}),
  };
}

export function newWatchId(): string {
  return randomBytes(8).toString('hex');
}

const WATCH_FILE = /^watch-([a-z0-9][a-z0-9-]{0,31})\.json$/;
const EVENT_FILE = /^event-\d+-[a-z0-9][a-z0-9-]{0,31}\.json$/;

export function createWatchStore(dir: string = getPaths().watchDir): WatchStore {
  const taskDir = (task: string): string => {
    requireTaskId(task);
    return join(dir, task);
  };
  const watchFile = (task: string, name: string): string => {
    if (!isWatchName(name)) throw new Error(`"${name.slice(0, 40)}" is not a watch name`);
    return join(taskDir(task), `watch-${name}.json`);
  };
  const ensure = (task: string): void => {
    mkdirSync(taskDir(task), { recursive: true, mode: 0o700 });
  };
  const readDef = (file: string): WatchDef | undefined => {
    try {
      return parseWatchDef(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return undefined;
    }
  };
  const listFiles = (task: string, pattern: RegExp): string[] => {
    try {
      return readdirSync(taskDir(task)).filter((file) => pattern.test(file));
    } catch {
      return [];
    }
  };
  const store: WatchStore = {
    tasks() {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && isSafeTaskId(entry.name))
          .map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    list(task) {
      const defs: WatchDef[] = [];
      const unreadable: string[] = [];
      for (const file of listFiles(task, WATCH_FILE)) {
        const def = readDef(join(taskDir(task), file));
        // A file under another name than its content's is not a watch of this store.
        if (def !== undefined && def.task === task && `watch-${def.name}.json` === file) defs.push(def);
        else unreadable.push(file);
      }
      return { defs, unreadable };
    },
    read(task, name) {
      const def = readDef(watchFile(task, name));
      return def !== undefined && def.task === task && def.name === name ? def : undefined;
    },
    write(def) {
      ensure(def.task);
      atomicWrite(watchFile(def.task, def.name), JSON.stringify(def));
    },
    update(def) {
      if (store.read(def.task, def.name)?.id !== def.id) return false;
      store.write(def);
      return true;
    },
    claim(task, name, id) {
      const file = watchFile(task, name);
      const claimed = `${file}.done-${process.pid}-${randomBytes(3).toString('hex')}`;
      try {
        renameSync(file, claimed);
      } catch {
        return undefined;
      }
      const def = readDef(claimed);
      if (def === undefined) {
        rmSync(claimed, { force: true });
        return undefined;
      }
      if (id !== undefined && def.id !== id) {
        // A watch that replaced the one the caller meant: give it back, unless a newer one took its place meanwhile.
        try {
          linkSync(claimed, file);
        } catch {
          // The name is taken again.
        }
        rmSync(claimed, { force: true });
        return undefined;
      }
      return { def, done: () => rmSync(claimed, { force: true }) };
    },
    all() {
      return store.tasks().flatMap((task) => store.list(task).defs);
    },
    events(task) {
      const stored: StoredEvent[] = [];
      for (const file of listFiles(task, EVENT_FILE)) {
        try {
          const event = parseWatchEvent(JSON.parse(readFileSync(join(taskDir(task), file), 'utf8')));
          if (event !== undefined && event.task === task) stored.push({ file, event });
        } catch {
          // Unreadable: left for a later look rather than lost.
        }
      }
      return stored.sort((a, b) => a.event.at.localeCompare(b.event.at) || a.file.localeCompare(b.file));
    },
    writeEvent(event) {
      ensure(event.task);
      const file = `event-${Date.parse(event.at)}-${event.name}.json`;
      atomicWrite(join(taskDir(event.task), file), JSON.stringify({ ...event, text: sanitizeEventText(event.text) }));
      return file;
    },
    updateEvent(task, { file, event }) {
      if (!EVENT_FILE.test(file)) return;
      const path = join(taskDir(task), file);
      // Only an event that is still there: one handed over meanwhile must not come back.
      try {
        statSync(path);
      } catch {
        return;
      }
      atomicWrite(path, JSON.stringify(event));
    },
    deleteEvents(task, files) {
      for (const file of files) if (EVENT_FILE.test(file)) rmSync(join(taskDir(task), file), { force: true });
    },
    touchHeartbeat(at) {
      const file = join(dir, '.heartbeat');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, '', { mode: 0o600 });
      utimesSync(file, at, at);
    },
    heartbeatAt() {
      try {
        return statSync(join(dir, '.heartbeat')).mtime;
      } catch {
        return undefined;
      }
    },
    markLive(task, pid) {
      ensure(task);
      atomicWrite(join(taskDir(task), 'live'), String(pid));
    },
    clearLive(task) {
      rmSync(join(taskDir(task), 'live'), { force: true });
    },
    livePid(task) {
      try {
        const pid = Number(readFileSync(join(taskDir(task), 'live'), 'utf8').trim());
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
      } catch {
        return undefined;
      }
    },
    dropTask(task) {
      rmSync(taskDir(task), { recursive: true, force: true });
    },
  };
  return store;
}
