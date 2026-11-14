// @vitest-environment node
// The real Caddyfile in the real `caddy:2` image, in front of a hostile backend: what a browser receives for a 200, a redirect,
// an error and a 304 when the backend tries to wipe the stored keys, set a cookie, redirect, register a service worker or pass
// itself off as a page. Skipped when docker or the image is not there (`docker pull caddy:2`).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim();

function hasImage(): boolean {
  try {
    docker('image', 'inspect', 'caddy:2');
    return true;
  } catch {
    return false;
  }
}

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

describe.skipIf(!hasImage())('the Caddyfile in front of a hostile backend (caddy:2)', () => {
  let upstream: Server;
  let name = '';
  let dir = '';
  let base = '';

  beforeAll(async () => {
    upstream = createServer((request, response) => {
      const hostile = HOSTILE[new URL(request.url ?? '/', 'http://x').pathname];
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
      'caddy:2',
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
    await new Promise((done) => upstream?.close(done));
  });

  const get = (path: string) => fetch(`${base}${path}`, { redirect: 'manual' });

  it.each(Object.keys(HOSTILE))('%s reaches the browser as data with the proxy’s headers only', async (path) => {
    const response = await get(path);
    expect(response.status).toBe(HOSTILE[path]?.[0]);
    for (const header of NEVER) expect(response.headers.has(header), header).toBe(false);
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toBe('attachment');
    if (response.status !== 304) expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  });

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
