import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';

// What keepAwake needs of a spawn: tests replace it.
export type Spawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => { once(event: 'error', listener: () => void): unknown; unref(): void; kill(): boolean };

// Holds the machine awake while this process runs (macOS): `caffeinate -i` keeps idle sleep off and `-w` ends it with
// the process. Best effort: a Mac without caffeinate, or one that cannot start it, runs the task all the same. The
// returned function ends it earlier.
export function keepAwake(pid: number = process.pid, start: Spawner = spawn): () => void {
  try {
    const child = start('caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore', detached: true });
    child.once('error', () => undefined);
    child.unref();
    return () => {
      child.kill();
    };
  } catch {
    return () => undefined;
  }
}
