import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('./main.mts', import.meta.url));

// The argv that starts this CLI again: the dispatcher starts workers with it, and a worker starts its hook with it.
export function selfCommand(...args: string[]): string[] {
  return [process.execPath, MAIN, ...args];
}
