import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { watchBoardChanges } from './changes.mts';
import type { ChangeWatchOptions } from './changes.mts';

const config = { url: 'https://board.example', token: 'tok' };

interface Controlled {
  response: Response;
  send: (text: string) => void;
  end: () => void;
}

// Like a real fetch body, the stream errors when the request's signal aborts.
function controlledStream(signal: AbortSignal): Controlled {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      signal.addEventListener('abort', () => c.error(signal.reason));
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200 }),
    send: (text) => controller?.enqueue(encoder.encode(text)),
    end: () => controller?.close(),
  };
}

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean): Promise<void> {
  for (let waited = 0; !condition(); waited += 1) {
    if (waited > 500) assert.fail('timed out waiting for the condition');
    await tick(2);
  }
}

interface Setup {
  options: ChangeWatchOptions;
  changes: number[];
  logs: string[];
  requests: { url: string; init: RequestInit }[];
}

function setup(fetch: (call: number) => Promise<Response>, overrides: Partial<ChangeWatchOptions> = {}): Setup {
  const changes: number[] = [];
  const logs: string[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  const options: ChangeWatchOptions = {
    config,
    fetch: (url, init) => {
      requests.push({ url, init });
      return fetch(requests.length);
    },
    onChange: () => changes.push(changes.length),
    log: (line) => logs.push(line),
    retryMs: 5,
    idleMs: 1000,
    ...overrides,
  };
  return { options, changes, logs, requests };
}

test('a tasks event calls onChange and other events do not', async () => {
  const abort = new AbortController();
  const stream = controlledStream(abort.signal);
  const { options, changes } = setup(() => Promise.resolve(stream.response));
  const watch = watchBoardChanges(options, abort.signal);
  try {
    stream.send(': ping\n\nevent: hello\ndata: {}\n\nevent: tasks\ndata: {}\n\n');
    await until(() => changes.length === 1);
    stream.send('event: tasks\ndata: {}\n\nevent: other\ndata: {}\n\n');
    await until(() => changes.length === 2);
    await tick();
    assert.equal(changes.length, 2);
  } finally {
    abort.abort();
    await watch;
  }
});

test('the stream is requested from the board with the machine headers, as an event stream', async () => {
  const abort = new AbortController();
  const stream = controlledStream(abort.signal);
  const { options, requests } = setup(() => Promise.resolve(stream.response));
  const watch = watchBoardChanges(options, abort.signal);
  try {
    await until(() => requests.length === 1);
    const [{ url, init }] = requests as [(typeof requests)[number]];
    assert.equal(url, 'https://board.example/api/machine/events');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer tok');
    assert.equal(headers['accept'], 'text/event-stream');
    assert.equal(init.signal, abort.signal);
    assert.equal(init.redirect, 'error');
  } finally {
    abort.abort();
    await watch;
  }
});

test('an answer that is not OK is logged once and retried after retryMs', async () => {
  const { options, logs, requests } = setup(() => Promise.resolve(new Response('no', { status: 503 })));
  const abort = new AbortController();
  const watch = watchBoardChanges(options, abort.signal);
  try {
    await until(() => requests.length >= 3);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? '', /event stream is lost \(the board answered the event stream with HTTP 503\)/);
  } finally {
    abort.abort();
    await watch;
  }
});

test('a retry waits for retryMs before it asks again', async () => {
  const { options, requests } = setup(() => Promise.resolve(new Response('no', { status: 500 })), { retryMs: 200 });
  const abort = new AbortController();
  const watch = watchBoardChanges(options, abort.signal);
  try {
    await until(() => requests.length === 1);
    await tick(50);
    assert.equal(requests.length, 1);
    await until(() => requests.length === 2);
  } finally {
    abort.abort();
    await watch;
  }
});

test('a fetch that throws is logged with its reason and retried', async () => {
  const { options, logs, requests } = setup(() => Promise.reject(new Error('connection refused')));
  const abort = new AbortController();
  const watch = watchBoardChanges(options, abort.signal);
  try {
    await until(() => requests.length >= 2);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? '', /event stream is lost \(connection refused\)/);
  } finally {
    abort.abort();
    await watch;
  }
});

test('a lost stream is logged again only after a connection succeeded in between', async () => {
  const abort = new AbortController();
  const stream = controlledStream(abort.signal);
  const { options, logs, requests } = setup((call) => {
    if (call === 3) return Promise.resolve(stream.response);
    return Promise.reject(new Error(call < 3 ? 'first outage' : 'second outage'));
  });
  const watch = watchBoardChanges(options, abort.signal);
  try {
    await until(() => requests.length === 3);
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? '', /first outage/);
    stream.end();
    await until(() => requests.length >= 5);
    assert.equal(logs.length, 2);
    assert.match(logs[1] ?? '', /second outage/);
  } finally {
    abort.abort();
    await watch;
  }
});

test('a stream that ends is reopened without a log', async () => {
  const abort = new AbortController();
  const first = controlledStream(abort.signal);
  const second = controlledStream(abort.signal);
  const { options, logs, requests, changes } = setup((call) =>
    Promise.resolve(call === 1 ? first.response : second.response),
  );
  const watch = watchBoardChanges(options, abort.signal);
  try {
    await until(() => requests.length === 1);
    first.end();
    await until(() => requests.length === 2);
    second.send('event: tasks\ndata: {}\n\n');
    await until(() => changes.length === 1);
    assert.deepEqual(logs, []);
  } finally {
    abort.abort();
    await watch;
  }
});

test('a stream that sends no bytes for idleMs counts as lost', async () => {
  const abort = new AbortController();
  const stream = controlledStream(abort.signal);
  const { options, logs, requests } = setup(() => Promise.resolve(stream.response), { idleMs: 20 });
  const watch = watchBoardChanges(options, abort.signal);
  try {
    await until(() => logs.length === 1);
    assert.match(logs[0] ?? '', /event stream is lost \(no bytes for 0\.02 s\)/);
    await until(() => requests.length >= 2);
  } finally {
    abort.abort();
    await watch;
  }
});

test('bytes arriving within idleMs keep the stream alive', async () => {
  const abort = new AbortController();
  const stream = controlledStream(abort.signal);
  const { options, logs } = setup(() => Promise.resolve(stream.response), { idleMs: 60 });
  const watch = watchBoardChanges(options, abort.signal);
  try {
    for (let beat = 0; beat < 4; beat += 1) {
      await tick(30);
      stream.send(': ping\n\n');
    }
    assert.deepEqual(logs, []);
  } finally {
    abort.abort();
    await watch;
  }
});

test('aborting during a read ends the watch without a log', async () => {
  const abort = new AbortController();
  const stream = controlledStream(abort.signal);
  const { options, logs, requests } = setup(() => Promise.resolve(stream.response));
  const watch = watchBoardChanges(options, abort.signal);
  await until(() => requests.length === 1);
  await tick();
  abort.abort();
  await watch;
  assert.deepEqual(logs, []);
  assert.equal(requests.length, 1);
});

test('aborting during the retry wait ends the watch at once', async () => {
  const { options, logs, requests } = setup(() => Promise.reject(new Error('down')), { retryMs: 60_000 });
  const abort = new AbortController();
  const watch = watchBoardChanges(options, abort.signal);
  await until(() => logs.length === 1);
  abort.abort();
  await watch;
  assert.equal(requests.length, 1);
});

test('a signal that is already aborted makes no request', async () => {
  const { options, requests } = setup(() => Promise.reject(new Error('never')));
  const abort = new AbortController();
  abort.abort();
  await watchBoardChanges(options, abort.signal);
  assert.equal(requests.length, 0);
});

test('aborting ends a read of a real fetch body at once, though the stream stays quiet', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': ping\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const abort = new AbortController();
    const { options, requests } = setup(() => Promise.reject(new Error('unused')), {
      config: { url: `http://127.0.0.1:${port}`, token: 'tok' },
      idleMs: 60_000,
    });
    const watch = watchBoardChanges(
      {
        ...options,
        fetch: (url, init) => {
          requests.push({ url, init });
          return fetch(url, init);
        },
      },
      abort.signal,
    );
    await until(() => requests.length === 1);
    await tick(50);
    const aborted = Date.now();
    abort.abort();
    await watch;
    assert.ok(Date.now() - aborted < 1000, 'ended long before idleMs');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
