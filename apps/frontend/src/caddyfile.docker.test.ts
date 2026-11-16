// @vitest-environment node
// The real Caddyfile in the Caddy image the web container ships (ARG CADDY_IMAGE in ../Dockerfile), in front of a hostile
// backend: what a browser receives for a 200, a redirect, an error, a 304 and an error Caddy makes itself when the backend
// tries to wipe the stored keys, set a cookie, redirect, register a service worker or pass itself off as a page, and that
// the event stream still passes chunk by chunk. Skipped where docker or the image is not there (`docker pull` the image);
// on CI that is a failure, since the job pulls it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();

const IMAGE = /^ARG CADDY_IMAGE=(\S+)$/m.exec(readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8'))?.[1];

function hasImage(): boolean {
  if (IMAGE === undefined) return false;
  try {
    docker('image', 'inspect', IMAGE);
    return true;
  } catch {
    return false;
  }
}

const available = hasImage();

it('pins the Caddy image by version and digest', () => {
  expect(IMAGE).toMatch(/^caddy:2\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
});

// A skip on CI would pass without a trace, and this is the only test that runs the Caddyfile.
it.runIf(Boolean(process.env.CI))('has docker and the Caddy image on CI', () => {
  expect(available, `docker image inspect ${IMAGE} failed: the CI job must pull it before the tests`).toBe(true);
});

const HOSTILE: Record<string, [number, Record<string, string>, string]> = {
  '/trpc/page': [
    200,
    {
      'Content-Type': 'text/html',
      'Content-Security-Policy': "script-src * 'unsafe-inline'",
      'X-Content-Type-Options': 'sniff',
      'Content-Disposition': 'inline',
    },
    '<script>indexedDB.deleteDatabase("agent-board-keys")</script>',
  ],
  '/trpc/wipe': [
    200,
    {
      'Content-Type': 'application/json',
      'Clear-Site-Data': '"storage"',
      'Set-Cookie': 'authelia_session=x; Path=/',
      Refresh: '0; url=https://evil.example/',
      Link: '</trpc/x>; rel=preload; as=script',
      'Content-Security-Policy-Report-Only': "default-src 'none'; report-uri https://evil.example/",
      'Service-Worker-Allowed': '/',
      'Access-Control-Allow-Origin': '*',
      'Strict-Transport-Security': 'max-age=0',
      'Content-Encoding': 'gzip',
      'X-Unknown-Header': 'whatever',
    },
    '{"result":{"data":null}}',
  ],
  '/trpc/sw.js': [
    200,
    { 'Content-Type': 'text/javascript', 'Service-Worker-Allowed': '/' },
    'self.addEventListener("fetch",()=>{})',
  ],
  '/trpc/redirect': [302, { Location: '/assets/x.js', 'Content-Type': 'text/html' }, '<p>moved</p>'],
  '/trpc/err500': [500, { 'Content-Type': 'text/html', 'Clear-Site-Data': '"cache", "storage"' }, '<script>x</script>'],
  '/trpc/notmod': [
    304,
    { 'Content-Type': 'text/html', ETag: '"a"', 'Clear-Site-Data': '"storage"', 'Set-Cookie': 'a=b' },
    '',
  ],
};

const NEVER = [
  'clear-site-data',
  'set-cookie',
  'refresh',
  'link',
  'location',
  'content-security-policy-report-only',
  'service-worker-allowed',
  'access-control-allow-origin',
  'strict-transport-security',
  'content-encoding',
  'etag',
  'x-unknown-header',
];

describe.skipIf(!available)(`the Caddyfile in front of a hostile backend (${IMAGE})`, () => {
  let upstream: Server;
  // The event stream's response while it is open, so a test can send the next chunk when it chooses.
  let stream: ServerResponse | undefined;
  let name = '';
  let dir = '';
  let base = '';

  beforeAll(async () => {
    upstream = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://x').pathname;
      if (path === '/trpc/hangup') {
        request.socket.destroy();
        return;
      }
      if (path === '/api/machine/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
          'Clear-Site-Data': '"storage"',
        });
        response.write(': connected\n\n');
        stream = response;
        return;
      }
      const hostile = HOSTILE[path];
      if (hostile === undefined) {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
        return;
      }
      response.writeHead(hostile[0], hostile[1]).end(hostile[2]);
    });
    await new Promise<void>((done) => upstream.listen(0, '0.0.0.0', done));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    dir = mkdtempSync(join(tmpdir(), 'agent-board-caddy-'));
    writeFileSync(
      join(dir, 'Caddyfile'),
      readFileSync(new URL('../Caddyfile', import.meta.url), 'utf8').replace(
        'backend:4000',
        `host.docker.internal:${upstreamPort}`,
      ),
    );
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
    name = `agent-board-caddy-test-${process.pid}`;
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--add-host=host.docker.internal:host-gateway',
      '-p',
      '127.0.0.1::80',
      '-v',
      `${join(dir, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`,
      '-v',
      `${join(dir, 'index.html')}:/srv/index.html:ro`,
      IMAGE ?? '',
    );
    base = `http://127.0.0.1:${docker('port', name, '80/tcp').split(':').pop()}`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fetch(`${base}/trpc/ok`);
        return;
      } catch {
        await new Promise((wait) => setTimeout(wait, 100));
      }
    }
    throw new Error(`caddy did not come up:\n${docker('logs', name)}`);
  }, 60_000);

  afterAll(async () => {
    if (name !== '') {
      try {
        docker('rm', '-f', name);
      } catch {
        // Already gone.
      }
    }
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    stream?.destroy();
    await new Promise((done) => upstream?.close(done));
  });

  const get = (path: string) => fetch(`${base}${path}`, { redirect: 'manual' });

  const expectDataOnly = (response: Response): void => {
    for (const header of NEVER) expect(response.headers.has(header), header).toBe(false);
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toBe('attachment');
  };

  it.each(Object.keys(HOSTILE))('%s reaches the browser as data with the proxy’s headers only', async (path) => {
    const response = await get(path);
    expect(response.status).toBe(HOSTILE[path]?.[0]);
    expectDataOnly(response);
    if (response.status !== 304) expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('answers a backend that hangs up with a 502 that carries the proxy’s headers', async () => {
    const response = await get('/trpc/hangup');
    expect(response.status).toBe(502);
    expectDataOnly(response);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

  it('leaves an error on the app’s own paths to the app’s headers', async () => {
    const response = await get('/assets/missing.js');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('passes the event stream on chunk by chunk, as data', async () => {
    // A client that accepts gzip, as the CLI's fetch does: `encode` must not hold the chunks back either.
    const response = await fetch(`${base}/api/machine/events`, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(response.status).toBe(200);
    expectDataOnly(response);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    const decoder = new TextDecoder();
    // Each chunk must arrive while the backend still holds the stream open, so a buffered stream times out here.
    const next = async (): Promise<string> => {
      const timeout = new Promise<never>((_, fail) =>
        setTimeout(() => fail(new Error('no chunk within 3 s: the stream is buffered')), 3_000),
      );
      const { value } = await Promise.race([reader.read(), timeout]);
      return decoder.decode(value, { stream: true });
    };
    expect(await next()).toBe(': connected\n\n');
    stream?.write('event: tasks\ndata:\n\n');
    expect(await next()).toBe('event: tasks\ndata:\n\n');
    await reader.cancel();
  }, 10_000);

  it('serves a script from a backend path as JSON, which a browser refuses as a service worker', async () => {
    const response = await get('/trpc/sw.js');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.has('service-worker-allowed')).toBe(false);
  });

  it('does not let the app register a worker at all', async () => {
    const response = await get('/');
    expect(response.headers.get('content-security-policy')).toContain("worker-src 'none'");
  });

  it('serves the app itself from the static files, with its own headers', async () => {
    const response = await get('/some/route');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});
