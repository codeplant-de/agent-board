/**
 * A held connection to the board's event stream (`/api/machine/events`), for the listener and `board events`: connects after
 * a check of the board's version, tells the caller on every connect and on every `tasks` event, and reconnects with a
 * backoff for as long as nothing says to stop. The stream carries no task data; what to do about a signal is the caller's.
 */
import { ConfigError } from '../config/config.mts';
import { errorText } from '../output/text.mts';
import { BackendError, machineHeaders } from './backend.mts';
import type { Fetch } from './backend.mts';
import { createSseParser } from './sse.mts';
import type { SseEvent } from './sse.mts';
import type { WebConfig } from './web-config.mts';

export interface Timers {
  now: () => number;
  // Calls `fn` after `ms`; returns the function that cancels it.
  after: (ms: number, fn: () => void) => () => void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export interface StreamOptions {
  // No bytes for this long (the server pings every 25 s) is a dead connection.
  idleMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  // A connection this old counts as healthy and resets the backoff.
  healthyMs: number;
}

export const REFUSED_TOKEN_MESSAGE =
  'the board refused the token (401): it was revoked or replaced; run "board init" with a new one';

// Rejects when `promise` takes longer than `ms`, or when `signal` aborts.
export function within<T>(
  promise: Promise<T>,
  ms: number,
  timers: Timers,
  signal: AbortSignal,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => finish(() => reject(new Error('stopped')));
    const cancel = timers.after(ms, () => finish(() => reject(new Error(`${what} took longer than ${ms / 1000} s`))));
    function finish(settle: () => void): void {
      cancel();
      signal.removeEventListener('abort', onAbort);
      settle();
    }
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort);
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}

// Reads the stream until it ends; throws when it goes quiet for `idleMs`.
async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
  { idleMs, timers, signal }: { idleMs: number; timers: Timers; signal: AbortSignal },
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(onEvent);
  try {
    for (;;) {
      const { done, value } = await within(reader.read(), idleMs, timers, signal, 'the stream, between two reads,');
      if (done) return;
      parser.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

// The delay before reconnect number `attempt` (from 0): doubles from the base to the cap, and is cut by up to half.
export function backoffMs(
  attempt: number,
  { backoffBaseMs, backoffMaxMs }: Pick<StreamOptions, 'backoffBaseMs' | 'backoffMaxMs'>,
  random: number,
): number {
  return Math.min(backoffMaxMs, backoffBaseMs * 2 ** attempt) * (0.5 + random / 2);
}

function sleep(ms: number, timers: Timers, signal: AbortSignal): Promise<void> {
  return within(new Promise<never>(() => undefined), ms, timers, signal, 'sleep').catch(() => undefined);
}

export interface StreamDeps<Target extends Pick<WebConfig, 'url' | 'token'>> {
  timers: Timers;
  // 0 to 1, for the backoff jitter.
  random: () => number;
  log: (line: string) => void;
  signal: AbortSignal;
  // Checks the contract version with a POST, like every other command; throws on a mismatch.
  verify: () => Promise<Target>;
  fetch: Fetch;
  options: StreamOptions;
  // The stream is open.
  onConnect: (target: Target) => void;
  // The board says tasks changed.
  onTasks: () => void;
  // A refused token ends the run with 1 instead of being tried again: for a command a person runs. The listener keeps
  // trying, because its token may be replaced on this machine.
  stopOnRefusedToken?: boolean;
}

// A 401 on the stream itself; a plain Error, so the listener logs it like any other lost connection.
class RefusedStream extends Error {}

// Runs until `signal` aborts (0) or the board no longer serves this CLI (1: its version, the config, or with `stopOnRefusedToken` the token).
export async function holdEventStream<Target extends Pick<WebConfig, 'url' | 'token'>>(
  deps: StreamDeps<Target>,
): Promise<number> {
  const { timers, log, signal, options } = deps;
  let attempt = 0;
  // A board server older than this CLI, or without the event stream, is a rollout in progress: keep trying, saying so once per state.
  let loggedOlder: string | undefined;
  while (!signal.aborted) {
    let connectedAt: number | undefined;
    const connection = new AbortController();
    const stopConnection = (): void => connection.abort();
    signal.addEventListener('abort', stopConnection);
    try {
      const target = await deps.verify();
      const response = await within(
        deps.fetch(`${target.url}/api/machine/events`, {
          headers: { ...machineHeaders(target.token), accept: 'text/event-stream' },
          signal: connection.signal,
          redirect: 'error',
        }),
        options.idleMs,
        timers,
        signal,
        'connecting',
      );
      if (response.status === 401) throw new RefusedStream(REFUSED_TOKEN_MESSAGE);
      if (!response.ok || response.body === null)
        throw new Error(`the board answered the event stream with HTTP ${response.status}`);
      connectedAt = timers.now();
      loggedOlder = undefined;
      log('connected');
      deps.onConnect(target);
      await readEvents(
        response.body,
        ({ event }) => {
          if (event === 'tasks') deps.onTasks();
        },
        { idleMs: options.idleMs, timers, signal },
      );
      log('disconnected: the board closed the stream');
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof BackendError && error.contractMismatch === 'cli-older') {
        log(error.message);
        return 1;
      }
      if (error instanceof ConfigError) {
        log(error.message);
        return 1;
      }
      const refused = error instanceof RefusedStream || (error instanceof BackendError && error.status === 401);
      if (refused && deps.stopOnRefusedToken === true) {
        log(REFUSED_TOKEN_MESSAGE);
        return 1;
      }
      if (
        error instanceof BackendError &&
        (error.contractMismatch === 'server-older' || error.missingFeature !== undefined)
      ) {
        if (error.message !== loggedOlder) log(error.message);
        loggedOlder = error.message;
      } else {
        log(refused && error instanceof BackendError ? REFUSED_TOKEN_MESSAGE : `disconnected: ${errorText(error)}`);
      }
    } finally {
      signal.removeEventListener('abort', stopConnection);
      connection.abort();
    }
    if (signal.aborted) break;
    if (connectedAt !== undefined && timers.now() - connectedAt >= options.healthyMs) attempt = 0;
    const delay = backoffMs(attempt, options, deps.random());
    attempt += 1;
    log(`reconnecting in ${(delay / 1000).toFixed(1)} s`);
    await sleep(delay, timers, signal);
  }
  return 0;
}
