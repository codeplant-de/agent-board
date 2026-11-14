import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A binary made by `bun build --compile` runs its code from a virtual /$bunfs/ file system.
export function isCompiledBinary(): boolean {
  return import.meta.url.startsWith('file:///$bunfs/');
}

// The argv that starts this CLI again: the dispatcher starts workers with it, and a worker starts its hook with it.
export function selfCommand(...args: string[]): string[] {
  if (isCompiledBinary()) return [process.execPath, ...args];
  return [process.execPath, fileURLToPath(new URL('./main.mts', import.meta.url)), ...args];
}

// Like selfCommand, for a unit file that outlives this process: a binary run from somewhere temporary points at the
// installed one (where install.sh puts it) when there is one.
export function installedCommand(env: Record<string, string | undefined>, ...args: string[]): string[] {
  if (!isCompiledBinary()) return selfCommand(...args);
  const installed = join(env['BOARD_INSTALL_DIR'] || join(homedir(), '.local', 'bin'), 'board');
  return [existsSync(installed) ? realpathSync(installed) : process.execPath, ...args];
}
