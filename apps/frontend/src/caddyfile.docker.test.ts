// @vitest-environment node
// The real Caddyfile in the Caddy image the web container ships (ARG CADDY_IMAGE in ../Dockerfile), in front of a hostile
// backend: what a browser receives for a 200, a redirect, an error, a 304 and an error Caddy makes itself when the backend
// tries to wipe the stored keys, set a cookie, redirect, register a service worker or pass itself off as a page, that Set-Cookie
// is the one header of the backend's that gets through, on /trpc only and only in the exact shape of the session cookie
// (never two, never one with a Domain), that the event stream still passes chunk by chunk, and that the SAML consumer's 303 is
// the one redirect that gets through, and only to /login/saml?flow=<id> or ?error=<code>. Caddy runs as the Dockerfile's USER with every capability dropped and
// no-new-privileges, as in the cluster. Skipped where docker or the image is not there (`docker pull` the image);
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

const DOCKERFILE = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const IMAGE = /^ARG CADDY_IMAGE=(\S+)$/m.exec(DOCKERFILE)?.[1];
const USER = /^USER (\S+)$/m.exec(DOCKERFILE)?.[1];

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

it('runs Caddy as a numeric non-root user, which runAsNonRoot can check', () => {
  expect(USER).toMatch(/^[1-9]\d*:[1-9]\d*$/);
});

// A skip on CI would pass without a trace, and this is the only test that runs the Caddyfile.
it.runIf(Boolean(process.env.CI))('has docker and the Caddy image on CI', () => {
  expect(available, `docker image inspect ${IMAGE} failed: the CI job must pull it before the tests`).toBe(true);
});

const TOKEN = `abs_${'A1_-'.repeat(10)}xyz`;
const SET_HTTPS = `__Host-board-session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000; Secure`;
const CLEAR_HTTPS = '__Host-board-session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure';
const SET_HTTP = `board-session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000`;
const CLEAR_HTTP = 'board-session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
const SESSION_COOKIES = [SET_HTTPS];

// What the backend's answer to /trpc/cookie carries as Set-Cookie, by the `case` the test asks for, and what may arrive.
const COOKIES: Record<string, { sent: string[]; passed: string[] }> = {
  'session, https': { sent: [SET_HTTPS], passed: [SET_HTTPS] },
  'clearing, https': { sent: [CLEAR_HTTPS], passed: [CLEAR_HTTPS] },
  'session, http': { sent: [SET_HTTP], passed: [SET_HTTP] },
  'clearing, http': { sent: [CLEAR_HTTP], passed: [CLEAR_HTTP] },
  Domain: { sent: [SET_HTTPS.replace('Path=/;', 'Path=/; Domain=example.com;')], passed: [] },
  'Domain last': { sent: [`${SET_HTTP}; Domain=example.com`], passed: [] },
  'another name': { sent: [SET_HTTP.replace('board-session', 'other')], passed: [] },
  'a name ending in ours': { sent: [SET_HTTP.replace('board-session', 'evil-board-session')], passed: [] },
  'no Secure on __Host-': { sent: [SET_HTTPS.replace('; Secure', '')], passed: [] },
  'Secure on the plain name': { sent: [`${SET_HTTP}; Secure`], passed: [] },
  'attributes reordered': {
    sent: [`board-session=${TOKEN}; HttpOnly; Path=/; SameSite=Lax; Max-Age=34560000`],
    passed: [],
  },
  'SameSite=None': { sent: [SET_HTTP.replace('Lax', 'None')], passed: [] },
  'a short token': { sent: ['board-session=abs_short; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000'], passed: [] },
  'text after the cookie': { sent: [`${SET_HTTP}x`], passed: [] },
  'a second cookie after a good one': { sent: [SET_HTTPS, 'evil=1; Domain=example.com; Path=/'], passed: [] },
  'a second cookie before a good one': { sent: ['evil=1; Domain=example.com; Path=/', SET_HTTPS], passed: [] },
  'two good cookies': { sent: [SET_HTTPS, CLEAR_HTTPS], passed: [] },
};

const BIG_BODY = `"${'x'.repeat(5 * 1024 * 1024)}"`;

const HOSTILE: Record<string, [number, Record<string, string | string[]>, string]> = {
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
      'Set-Cookie': SESSION_COOKIES,
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
  '/trpc/err401': [
    401,
    { 'Content-Type': 'text/html', 'Set-Cookie': CLEAR_HTTP, Location: '/login' },
    '{"error":{"message":"Sign in"}}',
  ],
  '/trpc/err415': [415, { 'Content-Type': 'text/plain', Refresh: '0; url=https://evil.example/' }, '{"error":"no"}'],
  '/api/cookie': [200, { 'Content-Type': 'text/html', 'Set-Cookie': SESSION_COOKIES }, '{"ok":true}'],
  '/healthz': [200, { 'Content-Type': 'text/html', 'Set-Cookie': SESSION_COOKIES }, '{"ok":true}'],
  '/trpc/notmod': [
    304,
    { 'Content-Type': 'text/html', ETag: '"a"', 'Clear-Site-Data': '"storage"', 'Set-Cookie': 'a=b' },
    '',
  ],
};

const ACS_PATH = '/api/auth/saml/acs';
const FLOW_LOCATION = '/login/saml?flow=abc_DEF-123';
const ERROR_LOCATION = '/login/saml?error=no_user';
const ACS_HEADERS = {
  'Content-Type': 'text/html',
  'Set-Cookie': 'session=x; Path=/',
  'Clear-Site-Data': '"storage"',
  Refresh: '0; url=https://evil.example/',
  'X-Unknown-Header': 'whatever',
};

// What the backend's answer to the SAML consumer is, by the `case` the test asks for: [status, Location].
const ACS: Record<string, [number, string]> = {
  good: [303, FLOW_LOCATION],
  'good error': [303, ERROR_LOCATION],
  absolute: [303, 'https://evil.example/login/saml?flow=abc'],
  'protocol-relative': [303, '//evil.example'],
  'protocol-relative flow': [303, '//evil.example/login/saml?flow=abc'],
  'other path': [303, '/other'],
  'another flow path': [303, '/login/saml/../../other?flow=abc'],
  'extra query': [303, '/login/saml?flow=abc&next=https://evil.example'],
  'no flow id': [303, '/login/saml?flow='],
  'error with capitals': [303, '/login/saml?error=Failed'],
  'error with a dash': [303, '/login/saml?error=no-user'],
  'error with a space': [303, '/login/saml?error=no%20user'],
  'error with text': [303, '/login/saml?error=<script>'],
  'empty error': [303, '/login/saml?error='],
  'long error': [303, `/login/saml?error=${'a'.repeat(33)}`],
  'error and flow': [303, '/login/saml?error=failed&flow=abc'],
  'error and a destination': [303, '/login/saml?error=failed&next=https://evil.example'],
  backslash: [303, '/login/saml?flow=abc\\evil'],
  'trailing text': [303, '/login/saml?flow=abc#//evil.example'],
  'wrong status': [302, FLOW_LOCATION],
  'see other, 307': [307, FLOW_LOCATION],
};

const NEVER = [
  'clear-site-data',
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
      if (path === ACS_PATH) {
        const [status, location] = ACS[new URL(request.url ?? '/', 'http://x').searchParams.get('case') ?? ''] ?? [
          200,
          '',
        ];
        response
          .writeHead(status, { ...ACS_HEADERS, ...(location === '' ? {} : { Location: location }) })
          .end('<p>x</p>');
        return;
      }
      if (path === '/trpc/cookie') {
        const sent = COOKIES[new URL(request.url ?? '/', 'http://x').searchParams.get('case') ?? '']?.sent ?? [];
        response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': sent }).end('{"result":{"data":null}}');
        return;
      }
      if (path === '/trpc/big') {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': SESSION_COOKIES }).end(BIG_BODY);
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
      readFileSync(new URL('../Caddyfile', import.meta.url), 'utf8').replaceAll(
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
      '--user',
      USER ?? '',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '-p',
      '127.0.0.1::8080',
      '-v',
      `${join(dir, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`,
      '-v',
      `${join(dir, 'index.html')}:/srv/index.html:ro`,
      IMAGE ?? '',
    );
    base = `http://127.0.0.1:${docker('port', name, '8080/tcp').split(':').pop()}`;
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

  /** `setCookies` are the cookies of the backend's answer that are meant to arrive: only /trpc passes them. */
  const expectDataOnly = (response: Response, setCookies: string[] = []): void => {
    expect(response.headers.getSetCookie()).toEqual(setCookies);
    for (const header of NEVER) expect(response.headers.has(header), header).toBe(false);
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toBe('attachment');
  };

  const cookiesOf = (path: string): string[] => {
    const sent = [HOSTILE[path]?.[1]['Set-Cookie'] ?? []].flat();
    return path.startsWith('/trpc/') ? sent.filter((cookie) => cookie !== 'a=b') : [];
  };

  it.each(Object.keys(HOSTILE))(
    '%s reaches the browser as data with the proxy’s headers, and Set-Cookie only on /trpc',
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(HOSTILE[path]?.[0]);
      expectDataOnly(response, cookiesOf(path));
      if (response.status !== 304) {
        expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
        expect(await response.text()).toBe(HOSTILE[path]?.[2]);
      }
    },
  );

  const acs = (name: string, method = 'POST') =>
    fetch(`${base}${ACS_PATH}?case=${encodeURIComponent(name)}`, { method, redirect: 'manual' });

  it.each([
    ['good', FLOW_LOCATION],
    ['good error', ERROR_LOCATION],
  ])(
    'passes the SAML consumer’s 303 to /login/saml with a flow id or an error code on as a 303 with that Location, and nothing else of the backend’s: %s',
    async (name, location) => {
      const response = await acs(name);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(location);
      for (const header of NEVER.filter((header) => header !== 'location'))
        expect(response.headers.has(header), header).toBe(false);
      expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe('');
    },
  );

  it.each(Object.keys(ACS).filter((name) => !name.startsWith('good')))(
    'does not send the browser anywhere on the SAML consumer’s answer: %s',
    async (name) => {
      const response = await acs(name);
      expect(response.headers.has('location')).toBe(false);
      expectDataOnly(response);
      // A 303 that is not the good one is an error of ours; any other status passes as the backend's, as data.
      expect(response.status).toBe(ACS[name]?.[0] === 303 ? 502 : ACS[name]?.[0]);
    },
  );

  it.each(Object.keys(COOKIES))('passes a Set-Cookie on /trpc only in the backend’s own shape: %s', async (name) => {
    const response = await get(`/trpc/cookie?case=${encodeURIComponent(name)}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"result":{"data":null}}');
    expectDataOnly(response, COOKIES[name]?.passed);
  });

  it('passes a large body unchanged with its status and cookie', async () => {
    const response = await fetch(`${base}/trpc/big`, { headers: { 'Accept-Encoding': 'identity' } });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual(SESSION_COOKIES);
    expect(await response.text()).toBe(BIG_BODY);
  });

  it('treats the SAML consumer’s other answers as data, with the backend’s headers dropped', async () => {
    const response = await acs('none');
    expect(response.status).toBe(200);
    expectDataOnly(response);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
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

  it('lets the app register only a worker of its own origin', async () => {
    const response = await get('/');
    expect(response.headers.get('content-security-policy')).toContain("worker-src 'self';");
  });

  it('serves the app itself from the static files, with its own headers', async () => {
    const response = await get('/some/route');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });
});
