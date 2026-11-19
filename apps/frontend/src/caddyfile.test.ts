// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const caddyfile = readFileSync(new URL('../Caddyfile', import.meta.url), 'utf8');
const code = caddyfile
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

/** The text of the block that opens at `opener` (a line such as `handle /trpc* {`), up to its matching brace. */
function blockAt(source: string, opener: string): string {
  const start = source.indexOf(opener);
  if (start < 0) throw new Error(`no ${opener}`);
  let depth = 0;
  for (let index = start + opener.length - 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${opener} is not closed`);
}

const snippet = blockAt(code, '(data_only) {');
const dataHeaders = blockAt(code, '(data_headers) {');
const trpc = blockAt(code, '\thandle /trpc* {');
const acs = blockAt(code, '\thandle /api/auth/saml/acs {');
const handles = [...code.matchAll(/^\thandle [^\n{]*\{/gm)].map((match) => blockAt(code.slice(match.index), match[0]));

describe('the web container’s Caddyfile', () => {
  it('proxies to the backend only in the data_only snippet and the /trpc and SAML consumer’s handles, and every other proxying handle imports the snippet', () => {
    expect(code.match(/reverse_proxy/g)).toHaveLength(3);
    expect(snippet).toContain('reverse_proxy');
    expect(trpc).toContain('reverse_proxy');
    expect(acs).toContain('reverse_proxy');
    const proxying = handles.filter((handle) => !handle.includes('file_server'));
    expect(proxying.map((handle) => handle.split('\n')[0])).toEqual([
      '\thandle /trpc* {',
      '\thandle /api/auth/saml/acs {',
      '\thandle /api/* {',
      '\thandle /healthz {',
    ]);
    for (const handle of proxying.filter((candidate) => candidate !== acs && candidate !== trpc)) {
      expect(handle).toContain('import data_only');
      expect(handle).not.toContain('reverse_proxy');
    }
    for (const handle of handles.filter((candidate) => candidate.includes('file_server')))
      expect(handle).not.toContain('import data_only');
  });

  it('fixes the content type and the CSP of every proxied answer at the last moment, over the backend’s', () => {
    expect(snippet).toMatch(/^\timport data_headers$/m);
    expect(dataHeaders).toContain('>Content-Type "application/json; charset=utf-8"');
    expect(dataHeaders).toContain(`>Content-Security-Policy "sandbox; default-src 'none'"`);
    expect(dataHeaders).toContain('>X-Content-Type-Options "nosniff"');
    expect(dataHeaders).toContain('>Content-Disposition "attachment"');
    expect(dataHeaders).toContain('>Cross-Origin-Resource-Policy "same-origin"');
    expect(dataHeaders).toContain('>Cache-Control "no-store"');
  });

  it('gives an error Caddy makes on a backend path the same headers', () => {
    const errors = blockAt(code, 'handle_errors {');
    expect(errors).toContain('@data path /trpc* /api/* /healthz');
    expect(blockAt(errors, 'handle @data {')).toMatch(/^\t\t\timport data_headers$/m);
  });

  it('drops every header the backend sends, so Clear-Site-Data, Refresh, Link, Location and the like never arrive', () => {
    for (const source of [snippet, trpc, acs]) {
      const proxy = blockAt(source, 'reverse_proxy backend:4000 {');
      expect(proxy).toMatch(/^\t+header_down -\*$/m);
      expect(source).not.toMatch(/header_down\s+(?!-\*)/);
      expect(source).not.toMatch(/header_up/);
    }
    // None of them is let through again by a rule of ours.
    for (const header of ['Clear-Site-Data', 'Refresh', 'Link', 'Location', 'Service-Worker-Allowed'])
      for (const source of [snippet, trpc]) expect(source).not.toMatch(new RegExp(header, 'i'));
  });

  it('lets Set-Cookie through on /trpc only when it is exactly the session cookie, and copies no other header', () => {
    const proxy = blockAt(trpc, 'reverse_proxy backend:4000 {');
    expect(trpc).toMatch(/^\t\timport data_headers$/m);
    expect(proxy.match(/handle_response/g)).toHaveLength(1);
    const handler = blockAt(proxy, 'handle_response {');
    const regex = /^\t+@session_cookie vars_regexp \{rp\.header\.Set-Cookie\} "(.+)"$/m.exec(handler)?.[1];
    if (regex === undefined) throw new Error('the Set-Cookie rule has no regexp');
    expect(handler).toMatch(/^\t+header @session_cookie Set-Cookie \{rp\.header\.Set-Cookie\}$/m);
    expect(handler).toMatch(/^\t+copy_response$/m);
    expect(regex).toMatch(/^\^.*\$$/);
    expect(regex).not.toMatch(/Domain|\.\*/);
    // Nowhere is a response header of the backend's copied as a whole.
    expect(code).not.toMatch(/copy_response_headers/);
    for (const source of [snippet, acs]) expect(source).not.toMatch(/Set-Cookie|copy_response/i);
  });

  describe('the Set-Cookie regexp', () => {
    const regex = new RegExp(/vars_regexp \{rp\.header\.Set-Cookie\} "(.+)"/.exec(trpc)?.[1] ?? 'no regexp');
    const token = `abs_${'A1_-'.repeat(10)}xyz`;
    const attributes = 'Path=/; HttpOnly; SameSite=Lax';

    it.each([
      `__Host-board-session=${token}; ${attributes}; Max-Age=34560000; Secure`,
      `__Host-board-session=; ${attributes}; Max-Age=0; Secure`,
      `board-session=${token}; ${attributes}; Max-Age=34560000`,
      `board-session=; ${attributes}; Max-Age=0`,
    ])('takes %s', (cookie) => {
      expect(regex.test(cookie)).toBe(true);
    });

    it.each([
      `board-session=${token}; ${attributes}; Max-Age=34560000; Domain=example.com`,
      `board-session=${token}; ${attributes}; Max-Age=34560000, other=1`,
      `__Host-board-session=${token}; ${attributes}; Max-Age=34560000`,
      `board-session=${token}; ${attributes}; Max-Age=34560000; Secure`,
      `other=${token}; ${attributes}; Max-Age=34560000`,
      `board-session=abs_short; ${attributes}; Max-Age=34560000`,
      `board-session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=34560000`,
      `x board-session=; ${attributes}; Max-Age=0`,
      '',
    ])('refuses %s', (cookie) => {
      expect(regex.test(cookie)).toBe(false);
    });
  });

  it('adds no header on the way in: sign-in is the backend’s, by the session cookie the browser sends on its own', () => {
    expect(code).not.toMatch(/header_up/);
    expect(caddyfile).not.toMatch(/PROXY_SECRET|Board-Proxy-Secret/);
  });

  it('lets the SAML consumer’s answer navigate only to /login/saml?flow=<id> or ?error=<code> on this origin, as Caddy’s own redirect', () => {
    // The same fixed headers as every backend answer.
    expect(acs).toMatch(/^\t\timport data_headers$/m);
    const proxy = blockAt(acs, 'reverse_proxy backend:4000 {');
    // One response handler, for a 303 and nothing else.
    expect(proxy.match(/handle_response/g)).toHaveLength(1);
    expect(proxy).toMatch(/^\t\t\t@signed_in status 303$/m);
    const handler = blockAt(proxy, 'handle_response @signed_in {');
    // The Location is checked in full, anchored, against a fixed path and a flow id or an error code, before it is used.
    expect(handler).toContain(
      '@return vars_regexp {rp.header.Location} ^/login/saml\\?(flow=[A-Za-z0-9_-]{1,128}|error=[a-z_]{1,32})$',
    );
    expect(blockAt(handler, 'handle @return {')).toMatch(/^\t+redir \{rp\.header\.Location\} 303$/m);
    // Any other 303 is an error of ours; the backend's answer is not passed on.
    expect(blockAt(handler, 'handle {')).toMatch(/^\t+respond 502$/m);
    // Nothing else of the upstream answer is copied into the redirect.
    expect(handler).not.toMatch(/rp\.header\.(?!Location\b)/);
    expect(handler).not.toMatch(/^\s*header\s/m);
    expect(handler.match(/redir/g)).toHaveLength(1);
  });

  it('allows workers only from the app’s own origin, and a backend path is data, not a script', () => {
    expect(code).toMatch(/Content-Security-Policy "[^"]*worker-src 'self'[;"]/);
  });
});
