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
const handles = [...code.matchAll(/^\thandle[^\n{]*\{/gm)].map((match) => blockAt(code, match[0]));

describe('the web container’s Caddyfile', () => {
  it('proxies to the backend only inside the data_only snippet, and every handle that proxies imports it', () => {
    expect(code.match(/reverse_proxy/g)).toHaveLength(1);
    expect(snippet).toContain('reverse_proxy');
    const proxying = handles.filter((handle) => !handle.includes('file_server'));
    expect(proxying.map((handle) => handle.split('\n')[0])).toEqual([
      '\thandle /trpc* {',
      '\thandle /api/* {',
      '\thandle /healthz {',
    ]);
    for (const handle of proxying) {
      expect(handle).toContain('import data_only');
      expect(handle).not.toContain('reverse_proxy');
    }
    for (const handle of handles.filter((candidate) => candidate.includes('file_server')))
      expect(handle).not.toContain('import data_only');
  });

  it('fixes the content type and the CSP of every proxied answer at the last moment, over the backend’s', () => {
    expect(snippet).toContain('>Content-Type "application/json; charset=utf-8"');
    expect(snippet).toContain(`>Content-Security-Policy "sandbox; default-src 'none'"`);
    expect(snippet).toContain('>X-Content-Type-Options "nosniff"');
    expect(snippet).toContain('>Content-Disposition "attachment"');
    expect(snippet).toContain('>Cross-Origin-Resource-Policy "same-origin"');
    expect(snippet).toContain('>Cache-Control "no-store"');
  });

  it('drops every header the backend sends, so Clear-Site-Data, Set-Cookie, Refresh, Link, Location and the like never arrive', () => {
    const proxy = blockAt(snippet, 'reverse_proxy backend:4000 {');
    expect(proxy).toMatch(/^\t\theader_down -\*$/m);
    // None of them is let through again by a rule of ours.
    for (const header of ['Clear-Site-Data', 'Set-Cookie', 'Refresh', 'Link', 'Location', 'Service-Worker-Allowed'])
      expect(snippet).not.toMatch(new RegExp(`${header}`, 'i'));
    expect(snippet).not.toMatch(/header_down\s+(?!-\*)/);
    // The proxy secret is the one header added on the way in.
    expect(snippet.match(/header_up.*/g)).toEqual(['header_up Board-Proxy-Secret {env.PROXY_SECRET}']);
  });

  it('sends the proxy secret, without which the backend ignores Remote-User and Remote-Groups, on every request to the backend', () => {
    const proxy = blockAt(snippet, 'reverse_proxy backend:4000 {');
    expect(proxy).toMatch(/^\t\theader_up Board-Proxy-Secret \{env\.PROXY_SECRET\}$/m);
  });

  it('allows no worker in the app, so no service worker can be registered, from a backend path or elsewhere', () => {
    expect(code).toMatch(/Content-Security-Policy "[^"]*worker-src 'none'/);
  });
});
