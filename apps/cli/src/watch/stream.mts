// A stream watch (`board watch --stream`): the watch unit keeps one command running and reports what it prints. The lines that
// arrive between two passes of the unit (2 seconds) go into one event; the command's exit is the last event and ends the watch.
// A command that prints too much is slowed down first (its lines are collected for longer) and then stopped. Nothing of a
// running command is on disk but two counts in its watch file, so a unit that starts finds a stream without a process and starts
// the command again from the beginning.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { localTime } from '../commands/schedule.mts';
import { errorText } from '../output/text.mts';
import { readSettingsEnv } from '../worker/settings-env.mts';
import { EVENT_TEXT_MAX_CHARS, sanitizeEventText } from './fence.mts';

/** The flood limits count over this long. */
export const STREAM_WINDOW_MS = 10 * 60_000;
/** More events than this within the window, and the command is stopped. */
export const STREAM_MAX_EVENTS = 50;
/** More output than this within the window, and the command is stopped. */
export const STREAM_MAX_BYTES = 20 * 1024;
/** From this many events within the window on, lines are collected for `STREAM_COALESCE_MS` before they are reported. */
export const STREAM_COALESCE_AFTER_EVENTS = 25;
export const STREAM_COALESCE_MS = 10_000;

// A line without an end is cut here and reported as it is.
const MAX_LINE_CHARS = 2000;
// What a batch keeps of its lines; an event shows 2000 characters at the most.
const PENDING_KEEP_CHARS = 2 * EVENT_TEXT_MAX_CHARS;

export interface StreamJob {
  command: string;
  cwd: string;
  // Whose `.claude` settings give the command their `env` (see WaitCheck.settingsDir).
  settingsDir?: string;
}

export interface StreamExit {
  // null: killed by a signal, or never started.
  exitCode: number | null;
  signal?: string;
  // Why the command could not be started.
  error?: string;
}

export interface StreamSink {
  // One line of stdout or stderr, without its line end.
  line: (text: string) => void;
  // Once, when the command is over.
  exit: (result: StreamExit) => void;
}

export interface StreamHandle {
  // Kills the command and what it started. `exit` may still follow.
  kill: () => void;
}

// Starts the command and feeds the sink; injected so tests start no process.
export type StreamStarter = (job: StreamJob, sink: StreamSink) => StreamHandle;

// Cuts what one pipe delivers into lines. Blank lines are dropped.
function lineSplitter(emit: (line: string) => void): { push: (chunk: Buffer) => void; end: () => void } {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  const out = (line: string): void => {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    for (let from = 0; from < text.length; from += MAX_LINE_CHARS) {
      const piece = text.slice(from, from + MAX_LINE_CHARS);
      if (piece.trim() !== '') emit(piece);
    }
  };
  const take = (text: string): void => {
    const pieces = (rest + text).split('\n');
    rest = pieces.pop() ?? '';
    for (const piece of pieces) out(piece);
    // A line without an end does not grow without bound.
    while (rest.length > MAX_LINE_CHARS) {
      out(rest.slice(0, MAX_LINE_CHARS));
      rest = rest.slice(MAX_LINE_CHARS);
    }
  };
  return {
    push: (chunk) => take(decoder.write(chunk)),
    end: () => {
      take(decoder.end());
      if (rest !== '') out(rest);
      rest = '';
    },
  };
}

/**
 * Starts a shell command as the agent would have (see `runCommand`): in its directory, with the `env` of the user's and the run's
 * Claude Code settings, in a process group of its own. It has no time limit; `kill` ends the whole group.
 */
export function startStream(job: StreamJob, sink: StreamSink, home: string = homedir()): StreamHandle {
  const { command, cwd, settingsDir } = job;
  let over = false;
  const exit = (result: StreamExit): void => {
    if (over) return;
    over = true;
    sink.exit(result);
  };
  let child;
  try {
    const env = { ...process.env, ...readSettingsEnv(home), ...readSettingsEnv(settingsDir ?? cwd) };
    child = spawn('bash', ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  } catch (error) {
    exit({ exitCode: null, error: errorText(error) });
    return { kill: () => undefined };
  }
  const started = child;
  const stdout = lineSplitter((line) => sink.line(line));
  const stderr = lineSplitter((line) => sink.line(line));
  started.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  started.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  started.on('error', (error) => exit({ exitCode: null, error: error.message }));
  started.on('close', (code, signal) => {
    stdout.end();
    stderr.end();
    exit({ exitCode: code, ...(signal === null ? {} : { signal }) });
  });
  return {
    kill() {
      // The whole process group: a command that started children must not leave them behind.
      try {
        if (started.pid !== undefined) process.kill(-started.pid, 'SIGKILL');
      } catch {
        started.kill('SIGKILL');
      }
    },
  };
}

export interface StreamReport {
  text: string;
  // Set when this report ends the watch: the command's exit is an `event`, a flood `stopped`.
  end?: 'event' | 'stopped';
}

export interface StreamSession extends StreamSink {
  // The handle of the command this session listens to.
  attach: (handle: StreamHandle) => void;
  // What there is to report now, if anything. The lines it returns are taken: the caller writes the event.
  step: () => StreamReport | undefined;
  kill: () => void;
}

export interface SessionOptions {
  now: () => Date;
  // The command ran before and was started again from the beginning (the unit restarted, or the machine rebooted).
  restarted?: boolean;
}

function exitLine({ exitCode, signal, error }: StreamExit): string {
  if (error !== undefined) return `The command could not be started: ${error}. The watch is over.`;
  if (exitCode === null) return `The command was killed (${signal ?? 'no exit code'}). The watch is over.`;
  return `The command exited with code ${exitCode}. The watch is over.`;
}

const FLOOD_LINE = `The command printed too much: more than ${STREAM_MAX_EVENTS} events or ${STREAM_MAX_BYTES / 1024} KB in ${STREAM_WINDOW_MS / 60_000} minutes. It was stopped and the watch is over.`;

/**
 * One running command of a stream watch: collects its lines, and says on `step` what to report. It keeps the flood counts and
 * kills the command itself the moment it printed more than 20 KB in 10 minutes.
 */
export function createStreamSession({ now, restarted = false }: SessionOptions): StreamSession {
  let handle: StreamHandle | undefined;
  let killed = false;
  let pending: string[] = [];
  let pendingChars = 0;
  // Lines of this batch that were dropped from its start.
  let leftOut = 0;
  let pendingSince: number | undefined;
  let exited: StreamExit | undefined;
  let flooded = false;
  // Output per second, and the time of each event, within the window.
  let bytes: { at: number; count: number }[] = [];
  let events: number[] = [];
  let notice = restarted
    ? `The watch unit was restarted (or the machine rebooted): the command was started again from the beginning at ${localTime(now())}. Lines it printed before may come again.`
    : undefined;

  const kill = (): void => {
    if (killed) return;
    killed = true;
    handle?.kill();
  };

  const flood = (): void => {
    flooded = true;
    kill();
  };

  // The lines of the batch as an event's text, with what stands before and after them; the lines give way when it gets long.
  const compose = (before: string | undefined, after: string | undefined): string => {
    const dropped = leftOut > 0 ? `(${leftOut} earlier line${leftOut === 1 ? '' : 's'} left out)` : undefined;
    const frame = [before, dropped, after].filter((part) => part !== undefined);
    const room = EVENT_TEXT_MAX_CHARS - frame.reduce((sum, part) => sum + part.length + 1, 0);
    const body = pending.length === 0 ? undefined : sanitizeEventText(pending.join('\n'), room);
    const text = [before, dropped, body, after].filter((part) => part !== undefined).join('\n');
    pending = [];
    pendingChars = 0;
    leftOut = 0;
    pendingSince = undefined;
    notice = undefined;
    return text;
  };

  return {
    attach(started) {
      handle = started;
      if (killed) started.kill();
    },
    line(text) {
      if (flooded || killed) return;
      const at = now().getTime();
      const second = at - (at % 1000);
      const last = bytes.at(-1);
      const count = Buffer.byteLength(text, 'utf8') + 1;
      if (last !== undefined && last.at === second) last.count += count;
      else bytes.push({ at: second, count });
      bytes = bytes.filter((entry) => at - entry.at < STREAM_WINDOW_MS);
      pending.push(text);
      pendingChars += text.length + 1;
      pendingSince ??= at;
      while (pendingChars > PENDING_KEEP_CHARS && pending.length > 1) {
        pendingChars -= (pending.shift()?.length ?? 0) + 1;
        leftOut += 1;
      }
      if (bytes.reduce((sum, entry) => sum + entry.count, 0) > STREAM_MAX_BYTES) flood();
    },
    exit(result) {
      exited ??= result;
    },
    step() {
      if (flooded) return { text: compose(notice, FLOOD_LINE), end: 'stopped' };
      if (exited !== undefined) return { text: compose(notice, exitLine(exited)), end: 'event' };
      if (pendingSince === undefined) return undefined;
      const at = now().getTime();
      events = events.filter((time) => at - time < STREAM_WINDOW_MS);
      if (events.length >= STREAM_MAX_EVENTS) {
        flood();
        return { text: compose(notice, FLOOD_LINE), end: 'stopped' };
      }
      if (events.length >= STREAM_COALESCE_AFTER_EVENTS && at - pendingSince < STREAM_COALESCE_MS) return undefined;
      events.push(at);
      return { text: compose(notice, undefined) };
    },
    kill,
  };
}
