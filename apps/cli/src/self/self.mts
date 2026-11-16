import { fileURLToPath } from 'node:url';

// Read once, at load. Bun computes it on first use, and a process that first asks after `board self-update` has renamed
// a new file over the binary gets "<path> (deleted)", which no worker or hook command can exec.
export const EXEC_PATH = process.execPath;

// A binary made by `bun build --compile` runs its code from a virtual /$bunfs/ file system.
export function isCompiledBinary(): boolean {
  return import.meta.url.startsWith('file:///$bunfs/');
}

// The argv that starts this CLI again: the dispatcher starts workers with it, a worker starts its hook with it, and
// `board setup` writes it into the units.
export function selfCommand(...args: string[]): string[] {
  if (isCompiledBinary()) return [EXEC_PATH, ...args];
  return [EXEC_PATH, fileURLToPath(new URL('../main.mts', import.meta.url)), ...args];
}
