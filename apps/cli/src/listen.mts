/**
 * The listener: holds a stream to the board and runs a dispatch tick when it says tasks changed, so a new task starts
 * in about a second instead of at the next timer tick. The timer stays as the fallback. The stream carries no task
 * data; a tick reads the board as it always does.
 */
import { spawn } from 'node:child_process';
import { ConfigError, getPaths } from './config.mts';
import { BackendError, loadWebConfig, verifyContract } from './backend.mts';
import type { Fetch, WebConfig } from './backend.mts';
import { print } from './cli.mts';
import { selfCommand } from './self.mts';

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

// Exit code of `flock -E 75`: the timer's tick holds the lock.
const LOCKED = 75;

export interface SseEvent {
  event: string;
  data: string;
}

// Server-sent events as they arrive in chunks: calls `onEvent` for each complete event, whatever the chunk boundaries.
export function createSseParser(onEvent: (event: SseEvent) => void): { push: (chunk: string) => void } {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  const line = (text: string): void => {
    if (text === '') {
      if (event !== '' || data.length > 0) onEvent({ event: event || 'message', data: data.join('\n') });
      event = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    const raw = colon === -1 ? '' : text.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };
  return {
    push(chunk) {
      buffer += chunk;
      // A trailing CR may be the first half of a CRLF; it waits for the next chunk.
      const held = buffer.endsWith('\r');
      const lines = (held ? buffer.slice(0, -1) : buffer).split(/\r\n|\n|\r/);
      buffer = (lines.pop() ?? '') + (held ? '\r' : '');
      lines.forEach(line);
    },
  };
}

export interface TickerOptions {
  // One dispatch tick: its exit code.
  run: () => Promise<number>;
  timers: Timers;
  log: (line: string) => void;
  debounceMs: number;
  retryMs: number;
}

export interface Ticker {
  // A tick right away (after a connect).
  now: () => void;
  // A tick after the debounce (after an event); events inside the window share it.
  soon: () => void;
  stop: () => void;
}

// Ticks never overlap: what arrives during one is a single dirty flag, and one more tick follows.
export function createTicker({ run, timers, log, debounceMs, retryMs }: TickerOptions): Ticker {
  let cancelPending: (() => void) | undefined;
  let running = false;
  let dirty = false;
  let stopped = false;

  const clearPending = (): void => {
    cancelPending?.();
    cancelPending = undefined;
  };
  const schedule = (ms: number): void => {
    clearPending();
    cancelPending = timers.after(ms, () => {
      cancelPending = undefined;
      void tick();
    });
  };
  async function tick(): Promise<void> {
    if (stopped) return;
    running = true;
    dirty = false;
    const started = timers.now();
    let code: number | undefined;
    try {
      code = await run();
    } catch (error) {
      log(`tick could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
    running = false;
    if (code === LOCKED) {
      log(`tick: the timer's tick holds the lock, retrying in ${retryMs / 1000} s`);
      schedule(retryMs);
      return;
    }
    if (code !== undefined) log(`tick: exit ${code} after ${((timers.now() - started) / 1000).toFixed(1)} s`);
    if (dirty) void tick();
  }
  return {
    now() {
      if (running) dirty = true;
      else {
        clearPending();
        void tick();
      }
    },
    soon() {
      if (running) dirty = true;
      else schedule(debounceMs);
    },
    stop() {
      stopped = true;
      clearPending();
    },
  };
}

export interface ListenerOptions {
  // No bytes for this long (the server pings every 25 s) is a dead connection.
  idleMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  // A connection this old counts as healthy and resets the backoff.
  healthyMs: number;
  debounceMs: number;
  retryMs: number;
}

export const LISTENER_OPTIONS: ListenerOptions = {
  idleMs: 60_000,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
  healthyMs: 30_000,
  debounceMs: 1000,
  retryMs: 5000,
};

export interface ListenerDeps {
  timers: Timers;
  // 0 to 1, for the backoff jitter.
  random: () => number;
  log: (line: string) => void;
  // Aborted on SIGTERM.
  signal: AbortSignal;
  // Checks the contract version with a POST, like every other command; throws on a mismatch.
  verify: () => Promise<Pick<WebConfig, 'url' | 'token'>>;
  fetch: Fetch;
  runTick: () => Promise<number>;
  options?: Partial<ListenerOptions>;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Rejects when `promise` takes longer than `ms`, or when `signal` aborts.
function within<T>(promise: Promise<T>, ms: number, timers: Timers, signal: AbortSignal, what: string): Promise<T> {
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
export function backoffMs(attempt: number, { backoffBaseMs, backoffMaxMs }: ListenerOptions, random: number): number {
  return Math.min(backoffMaxMs, backoffBaseMs * 2 ** attempt) * (0.5 + random / 2);
}

function sleep(ms: number, timers: Timers, signal: AbortSignal): Promise<void> {
  return within(new Promise<never>(() => undefined), ms, timers, signal, 'sleep').catch(() => undefined);
}

// Runs until `signal` aborts (exit code 0) or the contract does not match (1: systemd restarts it, on new code after an update).
export async function runListener(deps: ListenerDeps): Promise<number> {
  const { timers, log, signal } = deps;
  const options = { ...LISTENER_OPTIONS, ...deps.options };
  const ticker = createTicker({ run: deps.runTick, timers, log, ...options });
  let attempt = 0;
  try {
    while (!signal.aborted) {
      let connectedAt: number | undefined;
      const connection = new AbortController();
      const stopConnection = (): void => connection.abort();
      signal.addEventListener('abort', stopConnection);
      try {
        const target = await deps.verify();
        const response = await within(
          deps.fetch(`${target.url}/api/machine/events`, {
            headers: { authorization: `Bearer ${target.token}`, accept: 'text/event-stream' },
            signal: connection.signal,
            redirect: 'error',
          }),
          options.idleMs,
          timers,
          signal,
          'connecting',
        );
        if (response.status === 401)
          throw new Error(
            'the board refused the token (401): it was revoked or replaced; run "board init" with a new one',
          );
        if (!response.ok || response.body === null)
          throw new Error(`the board answered the event stream with HTTP ${response.status}`);
        connectedAt = timers.now();
        log('connected');
        ticker.now();
        await readEvents(
          response.body,
          ({ event }) => {
            if (event === 'tasks') ticker.soon();
          },
          { idleMs: options.idleMs, timers, signal },
        );
        log('disconnected: the board closed the stream');
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof BackendError && error.contractMismatch !== undefined) {
          log(error.message);
          return 1;
        }
        if (error instanceof ConfigError) {
          log(error.message);
          return 1;
        }
        log(
          error instanceof BackendError && error.status === 401
            ? 'the board refused the token (401): it was revoked or replaced; run "board init" with a new one'
            : `disconnected: ${describe(error)}`,
        );
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
  } finally {
    ticker.stop();
  }
  log('stopped');
  return 0;
}

// One dispatch tick as the timer's unit runs it, under the same lock; a separate process, so the dispatch code is the code on disk.
function spawnTick(env: Record<string, string | undefined>): Promise<number> {
  const lock = `${env['XDG_RUNTIME_DIR'] || '/tmp'}/agent-board-dispatch.lock`;
  const [program = 'flock', ...args] = [
    'flock',
    '-n',
    '-E',
    String(LOCKED),
    lock,
    ...selfCommand('internal', 'dispatch'),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? -1));
  });
}

export async function listenMain(): Promise<void> {
  const { configDir } = getPaths();
  const stop = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT'] as const) process.once(name, () => stop.abort());
  process.exitCode = await runListener({
    timers: realTimers,
    random: Math.random,
    log: print,
    signal: stop.signal,
    verify: async () => {
      const config = loadWebConfig(configDir);
      await verifyContract(config);
      return config;
    },
    fetch: (url, init) => fetch(url, init),
    runTick: () => spawnTick(process.env),
  });
}
