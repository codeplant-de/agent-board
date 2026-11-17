// Fetching an agent definition someone posted as a URL. An agent definition grants permissions, so the fetch is narrow:
// https only, a short timeout, a size cap, and redirects only to https on the same host.
import { createHash } from 'node:crypto';
import { request } from 'node:https';
import type { RequestOptions } from 'node:https';
import { ConfigError } from './config-error.mts';
import { MAX_AGENT_DOCUMENT_BYTES } from './agent-document.mts';

export const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  // Extra trust for a test's own certificate; never set outside tests.
  ca?: string;
}

/** A URL and the sha256 its `#sha256=<hex>` fragment pins, if it has one. Anything but https is refused. */
export function parseAgentUrl(text: string): { url: URL; sha256?: string } {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`not a URL: ${text.slice(0, 200)}`);
  }
  if (url.protocol !== 'https:')
    throw new ConfigError(`only https:// URLs are fetched, not ${url.protocol.replace(/:$/, '')}`);
  if (url.username !== '' || url.password !== '')
    throw new ConfigError('a URL with a user name or password is refused');
  const fragment = url.hash.replace(/^#/, '');
  if (fragment === '') return { url };
  const pin = /^sha256=([0-9a-fA-F]{64})$/.exec(fragment);
  if (pin?.[1] === undefined) throw new ConfigError('the URL fragment must be #sha256=<64 hex digits> or nothing');
  return { url, sha256: pin[1].toLowerCase() };
}

export const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function getOnce(
  url: URL,
  options: Required<Omit<FetchOptions, 'ca'>> & Pick<FetchOptions, 'ca'>,
): Promise<{ status: number; location?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const requestOptions: RequestOptions = {
      method: 'GET',
      headers: { accept: 'application/yaml, application/json, text/plain, */*', 'user-agent': 'agent-board-cli' },
      timeout: options.timeoutMs,
      ...(options.ca === undefined ? {} : { ca: options.ca }),
    };
    const req = request(url, requestOptions, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        const location = res.headers.location;
        resolve({ status, ...(location === undefined ? {} : { location }), body: Buffer.alloc(0) });
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        req.destroy();
        reject(
          new ConfigError(`${url.host} sends ${declared} bytes; an agent definition is at most ${options.maxBytes}`),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          req.destroy();
          reject(new ConfigError(`${url.host} sends more than ${options.maxBytes} bytes; that is no agent definition`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new ConfigError(`${url.host} did not answer within ${options.timeoutMs} ms`)));
    req.on('error', (error) =>
      reject(error instanceof ConfigError ? error : new ConfigError(`cannot fetch ${url.href}: ${error.message}`)),
    );
    req.end();
  });
}

/**
 * The body of an https URL. A redirect is followed only to https on the same host, at most 3 times; anything but a 200 is
 * an error. With `sha256`, a body whose hash differs is refused.
 */
export async function fetchAgentText(
  url: URL,
  sha256: string | undefined,
  options: FetchOptions = {},
): Promise<string> {
  const settings = {
    timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? MAX_AGENT_DOCUMENT_BYTES,
    ...(options.ca === undefined ? {} : { ca: options.ca }),
  };
  let current = new URL(url.href);
  current.hash = '';
  for (let hop = 0; ; hop++) {
    const response = await getOnce(current, settings);
    if (response.status >= 300 && response.status < 400) {
      if (response.location === undefined) throw new ConfigError(`${current.host} redirects without a location`);
      if (hop >= MAX_REDIRECTS) throw new ConfigError(`${url.host} redirects more than ${MAX_REDIRECTS} times`);
      const next = new URL(response.location, current);
      if (next.protocol !== 'https:' || next.host !== url.host)
        throw new ConfigError(
          `${url.host} redirects to ${next.protocol}//${next.host}; only a redirect to https on the same host is followed`,
        );
      current = next;
      continue;
    }
    if (response.status !== 200)
      throw new ConfigError(`${current.host} answers ${response.status} for ${current.pathname}`);
    if (sha256 !== undefined) {
      const actual = sha256Hex(response.body);
      if (actual !== sha256)
        throw new ConfigError(
          `the fetched file has sha256 ${actual}, not the ${sha256} the URL pins; nothing was written`,
        );
    }
    return response.body.toString('utf8');
  }
}
