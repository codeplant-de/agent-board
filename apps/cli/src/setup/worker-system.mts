import { createProcessSystem } from './process-system.mts';
import { createSystem } from './system.mts';
import type { System } from './system.mts';

// Where a run goes: a transient systemd unit on Linux, a detached process tracked in the run directory on macOS.
export function createWorkerSystem(input: {
  dryRun: boolean;
  print: (line: string) => void;
  platform?: string;
}): System {
  return (input.platform ?? process.platform) === 'darwin' ? createProcessSystem(input) : createSystem(input);
}
