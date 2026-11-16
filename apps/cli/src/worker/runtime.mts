// Per-task files of a run on this machine, shared by the dispatcher, the worker and the agent's hook:
//   <task>.run    which lane runs it, whether borrowed, since when (written by the dispatcher at the start)
//   <task>.alive  touched by the hook on every tool call: its mtime is the agent's last sign of life
//   <task>.pause  present while the dispatcher asks the run to give up its slot
//   <task>.cwd    the agent's working directory at its last tool call (it may have entered a worktree)
// They live in $XDG_RUNTIME_DIR, private to the user, apart from any checkout.
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord, isSafeWorkdir } from '@agent-board/shared';

export interface RunRecord {
  lane: string;
  borrowed: boolean;
  startedAt: Date;
}

export interface RunFiles {
  dir: string;
  writeRun(taskId: string, record: RunRecord): void;
  readRun(taskId: string): RunRecord | undefined;
  // When the agent last made a tool call; undefined before its first one.
  lastActive(taskId: string): Date | undefined;
  touchAlive(taskId: string, at?: Date): void;
  writeCwd(taskId: string, cwd: string): void;
  lastCwd(taskId: string): string | undefined;
  requestPause(taskId: string): void;
  // When the pause was asked for; undefined when it was not.
  pauseRequestedAt(taskId: string): Date | undefined;
  // All of the task's files: the run is over.
  clear(taskId: string): void;
}

export function runDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env['AGENT_BOARD_RUN_DIR']) return env['AGENT_BOARD_RUN_DIR'];
  const base = env['XDG_RUNTIME_DIR'] ?? `/run/user/${process.getuid?.() ?? 0}`;
  return join(base, 'agent-board');
}

function mtime(path: string): Date | undefined {
  return statSync(path, { throwIfNoEntry: false })?.mtime;
}

export function createRunFiles(dir: string = runDir()): RunFiles {
  const path = (taskId: string, kind: 'run' | 'alive' | 'pause' | 'cwd'): string => join(dir, `${taskId}.${kind}`);
  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  };
  return {
    dir,
    writeRun(taskId, record) {
      ensureDir();
      writeFileSync(path(taskId, 'run'), JSON.stringify({ ...record, startedAt: record.startedAt.toISOString() }), {
        mode: 0o600,
      });
    },
    readRun(taskId) {
      try {
        const raw: unknown = JSON.parse(readFileSync(path(taskId, 'run'), 'utf8'));
        if (
          !isRecord(raw) ||
          typeof raw['lane'] !== 'string' ||
          typeof raw['borrowed'] !== 'boolean' ||
          typeof raw['startedAt'] !== 'string'
        )
          return undefined;
        return { lane: raw['lane'], borrowed: raw['borrowed'], startedAt: new Date(raw['startedAt']) };
      } catch {
        return undefined;
      }
    },
    lastActive: (taskId) => mtime(path(taskId, 'alive')),
    touchAlive(taskId, at = new Date()) {
      ensureDir();
      const file = path(taskId, 'alive');
      try {
        utimesSync(file, at, at);
      } catch {
        writeFileSync(file, '', { mode: 0o600 });
        utimesSync(file, at, at);
      }
    },
    writeCwd(taskId, cwd) {
      ensureDir();
      writeFileSync(path(taskId, 'cwd'), cwd, { mode: 0o600 });
    },
    lastCwd(taskId) {
      try {
        const cwd = readFileSync(path(taskId, 'cwd'), 'utf8').trim();
        return isSafeWorkdir(cwd) ? cwd : undefined;
      } catch {
        return undefined;
      }
    },
    requestPause(taskId) {
      ensureDir();
      writeFileSync(path(taskId, 'pause'), '', { mode: 0o600, flag: 'wx' });
    },
    pauseRequestedAt: (taskId) => mtime(path(taskId, 'pause')),
    clear(taskId) {
      for (const kind of ['run', 'alive', 'pause', 'cwd'] as const) rmSync(path(taskId, kind), { force: true });
    },
  };
}
