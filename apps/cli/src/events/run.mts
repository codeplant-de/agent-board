/**
 * `board events`: holds the board's event stream and prints what changed. The stream only says that tasks changed, so
 * after every signal, after every (re)connect and on a slow timer the open tasks are listed again and compared with the
 * listing before. The first listing is the baseline and prints nothing.
 */
import { BackendError } from '../backend/backend.mts';
import type { Fetch } from '../backend/backend.mts';
import { holdEventStream, REFUSED_TOKEN_MESSAGE } from '../backend/event-stream.mts';
import type { StreamOptions, Timers } from '../backend/event-stream.mts';
import type { WebConfig } from '../backend/web-config.mts';
import { ConfigError } from '../config/config.mts';
import { errorText } from '../output/text.mts';
import { diffTasks, matchesFilter } from './diff.mts';
import type { BoardEvent, EventFilter } from './diff.mts';
import type { Backend, Task } from '@agent-board/shared';

export interface EventsOptions extends StreamOptions {
  // Signals inside this window share one refresh.
  debounceMs: number;
  // Some changes send no event (the hourly cleanup closing old Done tasks), so the board is listed again this often.
  pollMs: number;
}

export const EVENTS_OPTIONS: EventsOptions = {
  idleMs: 60_000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
  healthyMs: 30_000,
  debounceMs: 300,
  pollMs: 2 * 60_000,
};

// What the board's `version` answer said about this connection.
export interface EventsTarget extends Pick<WebConfig, 'url' | 'token'> {
  features: ReadonlySet<string>;
}

export interface EventsDeps {
  timers: Timers;
  random: () => number;
  // Connection messages: stderr, so stdout stays the events alone.
  log: (line: string) => void;
  // Aborted on SIGINT and SIGTERM.
  signal: AbortSignal;
  verify: () => Promise<EventsTarget>;
  fetch: Fetch;
  backend: Pick<Backend, 'listTasks' | 'getTask' | 'readNotes'>;
  filter: EventFilter;
  // Prints one event; throws when stdout is closed.
  emit: (event: BoardEvent) => void;
  now: () => Date;
  options?: Partial<EventsOptions>;
}

const NO_NOTES_NOTICE =
  'this board server does not count the notes of a task (task.note-count): notes are not reported; update the board server';

const isClosedPipe = (error: unknown): boolean =>
  error instanceof Error && ['EPIPE', 'ERR_STREAM_DESTROYED'].includes((error as { code?: string }).code ?? '');

// Runs until `signal` aborts or stdout closes (exit code 0), or until the board refuses this machine for good (1: the token, the CLI's age, the config).
export async function runEvents(deps: EventsDeps): Promise<number> {
  const { timers, log } = deps;
  const options = { ...EVENTS_OPTIONS, ...deps.options };
  // Ends the stream when a refresh decides the run is over.
  const stopped = new AbortController();
  const stop = (): void => stopped.abort();
  deps.signal.addEventListener('abort', stop);
  let exitCode = 0;
  const finish = (code: number): void => {
    exitCode = code;
    stop();
  };

  let snapshot: Task[] | undefined;
  let running = false;
  let dirty = false;
  let current: Promise<void> | undefined;
  let cancelPending: (() => void) | undefined;
  let cancelPoll: (() => void) | undefined;
  let failing = false;
  let warnedNotes = false;

  const clear = (): void => {
    cancelPending?.();
    cancelPending = undefined;
    cancelPoll?.();
    cancelPoll = undefined;
  };

  async function refresh(): Promise<void> {
    running = true;
    dirty = false;
    clear();
    try {
      const listed = await deps.backend.listTasks();
      const events =
        snapshot === undefined
          ? []
          : await diffTasks(snapshot, listed, {
              readNotes: deps.backend.readNotes,
              getTask: deps.backend.getTask,
              at: deps.now(),
            });
      snapshot = listed;
      if (failing) log('the board can be read again');
      failing = false;
      for (const event of events.filter((candidate) => matchesFilter(candidate, deps.filter))) {
        try {
          deps.emit(event);
        } catch (error) {
          if (isClosedPipe(error)) return finish(0);
          log(`cannot write: ${errorText(error)}`);
          return finish(1);
        }
      }
    } catch (error) {
      if (stopped.signal.aborted) return;
      const refused = error instanceof BackendError && error.status === 401;
      if (
        refused ||
        error instanceof ConfigError ||
        (error instanceof BackendError && error.contractMismatch === 'cli-older')
      ) {
        log(refused ? REFUSED_TOKEN_MESSAGE : errorText(error));
        return finish(1);
      }
      if (!failing)
        log(
          `cannot read the board: ${errorText(error)}; trying again at the next change or in ${options.pollMs / 1000} s`,
        );
      failing = true;
    } finally {
      running = false;
      if (!stopped.signal.aborted) {
        if (dirty) void start();
        else cancelPoll = timers.after(options.pollMs, now);
      }
    }
  }
  function start(): Promise<void> {
    current = refresh();
    return current;
  }
  function now(): void {
    if (stopped.signal.aborted) return;
    if (running) dirty = true;
    else {
      clear();
      void start();
    }
  }
  function soon(): void {
    if (stopped.signal.aborted) return;
    if (running) dirty = true;
    else {
      cancelPending?.();
      cancelPending = timers.after(options.debounceMs, () => {
        cancelPending = undefined;
        void start();
      });
    }
  }

  try {
    const code = await holdEventStream<EventsTarget>({
      timers,
      random: deps.random,
      log,
      signal: stopped.signal,
      verify: deps.verify,
      fetch: deps.fetch,
      options,
      stopOnRefusedToken: true,
      onConnect: ({ features }) => {
        if (!features.has('task.note-count') && !warnedNotes) {
          warnedNotes = true;
          log(NO_NOTES_NOTICE);
        }
        now();
      },
      onTasks: soon,
    });
    if (exitCode === 0) exitCode = code;
  } finally {
    deps.signal.removeEventListener('abort', stop);
    stop();
    clear();
    await current;
    clear();
  }
  return exitCode;
}
