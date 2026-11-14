import { readFileSync } from 'node:fs';

// A checkout reports its package version as a development build.
export function cliVersion(): string {
  const raw: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const version = typeof raw === 'object' && raw !== null && 'version' in raw ? raw.version : undefined;
  return `${typeof version === 'string' ? version : '0.0.0'}-dev`;
}
