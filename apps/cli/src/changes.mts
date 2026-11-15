/**
 * A worker's own subscription to the board's event stream: the stream says "tasks changed" without any data, and the worker
 * looks at its run inbox again. The watch's tick is the fallback, so a stream that cannot be had is no failure.
 */
import { machineHeaders } from './backend.mts';
import type { Fetch, WebConfig } from './backend.mts';
import { createSseParser } from './listen.mts';

export interface ChangeWatchOptions {
  config: Pick<WebConfig, 'url' | 'token'>;
  fetch: Fetch;
  onChange: () => void;
  log: (line: string) => void;
  // Between a lost stream and the next try.
  retryMs: number;
  // No bytes for this long (the server pings every 25 s) is a dead connection.
  idleMs: number;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Reads the stream until it ends or `signal` aborts; throws when it goes quiet for `idleMs`.
async function readStream(body: ReadableStream<Uint8Array>, options: ChangeWatchOptions, signal: AbortSignal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(({ event }) => {
    if (event === 'tasks') options.onChange();
  });
  try {
    for (;;) {
      let idle: NodeJS.Timeout | undefined;
      const quiet = new Promise<never>((_resolve, reject) => {
        idle = setTimeout(() => reject(new Error(`no bytes for ${options.idleMs / 1000} s`)), options.idleMs);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), quiet]);
        if (done || signal.aborted) return;
        parser.push(decoder.decode(value, { stream: true }));
      } finally {
        clearTimeout(idle);
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

// Keeps a stream open, reconnecting, until `signal` aborts. Says in the log when it is lost, once until it is back.
export async function watchBoardChanges(options: ChangeWatchOptions, signal: AbortSignal): Promise<void> {
  let lost = false;
  while (!signal.aborted) {
    try {
      const response = await options.fetch(`${options.config.url}/api/machine/events`, {
        headers: { ...machineHeaders(options.config.token), accept: 'text/event-stream' },
        signal,
        redirect: 'error',
      });
      if (!response.ok || response.body === null)
        throw new Error(`the board answered the event stream with HTTP ${response.status}`);
      lost = false;
      await readStream(response.body, options, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (!lost)
        options.log(`the board's event stream is lost (${describe(error)}); the run inbox is checked on the timer`);
      lost = true;
    }
    await new Promise<void>((resolve) => {
      const wake = setTimeout(resolve, options.retryMs);
      signal.addEventListener('abort', () => {
        clearTimeout(wake);
        resolve();
      });
    });
  }
}
