// Locks on the linked git worktrees that tasks work in, so that a cleanup of merged branches does not delete one that an open
// task still uses: a locked worktree makes `git worktree remove` refuse (it takes `-f -f`) and `git worktree prune` skip it,
// and the lock's reason names the task. The worker locks the directory it stores as the task's workdir, the hook locks a
// worktree the agent enters during the run, and the dispatcher unlocks them once the task is done, closed or deleted.
// Which worktrees a task locked is kept on this machine:
//   <state dir>/worktree-locks/<task>.json   the roots of the worktrees, a JSON array
// A worktree that someone else locked is left alone and not recorded.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isSafeTaskId } from '@agent-board/shared';
import { getPaths } from '../config/config.mts';
import { requireTaskId } from '../task-id.mts';
import { errorText } from '../output/text.mts';

const GIT_TIME_LIMIT_MS = 10_000;

export function lockReason(taskId: string): string {
  return `agent-board task ${taskId}`;
}

export interface WorktreeLocks {
  // Locks the linked worktree that holds `dir` for the task and records it. Returns a line for the log when it locked one or
  // could not; nothing when `dir` is not in a linked worktree or the task holds it already. Never throws.
  hold(taskId: string, dir: string): string | undefined;
  // Unlocks the worktrees the task holds, except the one that holds `keep`, and forgets them. Returns lines for the log.
  release(taskId: string, keep?: string): string[];
  // The tasks that hold a worktree on this machine.
  tasks(): string[];
}

interface Worktree {
  root: string;
  gitDir: string;
  linked: boolean;
}

// Runs git; its stdout, or undefined when it failed. The error goes to `failed` when given.
function git(dir: string, args: string[], failed?: (reason: string) => void): string | undefined {
  const result = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIME_LIMIT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return result.stdout;
  failed?.(result.error ? errorText(result.error) : result.stderr.trim() || `git exited with ${String(result.status)}`);
  return undefined;
}

// The worktree that holds `dir`; undefined when it is not in a git checkout or not there.
function worktreeOf(dir: string): Worktree | undefined {
  const out = git(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  const [root, gitDir, commonDir] = out?.split('\n') ?? [];
  if (!root || !gitDir || !commonDir) return undefined;
  return { root, gitDir, linked: gitDir !== commonDir };
}

// The reason a linked worktree is locked for: the content of its `locked` file (gitrepository-layout); undefined when it is not.
function lockedFor(worktree: Worktree): string | undefined {
  try {
    return readFileSync(join(worktree.gitDir, 'locked'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

export function createWorktreeLocks(dir: string = join(getPaths().stateDir, 'worktree-locks')): WorktreeLocks {
  const file = (taskId: string): string => {
    requireTaskId(taskId);
    return join(dir, `${taskId}.json`);
  };
  const read = (taskId: string): string[] => {
    try {
      const raw: unknown = JSON.parse(readFileSync(file(taskId), 'utf8'));
      return Array.isArray(raw)
        ? raw.filter((path): path is string => typeof path === 'string' && isAbsolute(path))
        : [];
    } catch {
      return [];
    }
  };
  const write = (taskId: string, roots: string[]): void => {
    if (roots.length === 0) {
      rmSync(file(taskId), { force: true });
      return;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file(taskId), JSON.stringify(roots), { mode: 0o600 });
  };

  return {
    hold(taskId, path) {
      try {
        const worktree = worktreeOf(path);
        if (worktree === undefined || !worktree.linked) return undefined;
        const reason = lockReason(taskId);
        const remember = (): void => {
          const roots = read(taskId);
          if (!roots.includes(worktree.root)) write(taskId, [...roots, worktree.root]);
        };
        const current = lockedFor(worktree);
        if (current === reason) {
          remember();
          return undefined;
        }
        if (current !== undefined) return `the worktree ${worktree.root} is locked already (${current}); left as it is`;
        let failure = '';
        if (
          git(worktree.root, ['worktree', 'lock', '--reason', reason, worktree.root], (why) => (failure = why)) ===
          undefined
        )
          return `could not lock the worktree ${worktree.root}: ${failure}`;
        remember();
        return `locked the worktree ${worktree.root} for this task`;
      } catch (error) {
        return `could not lock the worktree of ${path}: ${errorText(error)}`;
      }
    },

    release(taskId, keep) {
      const lines: string[] = [];
      const roots = read(taskId);
      if (roots.length === 0) return lines;
      const kept = keep === undefined ? undefined : worktreeOf(keep)?.root;
      // What stays on the record: the kept worktree, and any that could not be unlocked, for the next try.
      const left: string[] = [];
      for (const root of roots) {
        if (root === kept) {
          left.push(root);
          continue;
        }
        const worktree = worktreeOf(root);
        // Gone, or no longer the root of a worktree: there is nothing left to unlock.
        if (worktree === undefined || worktree.root !== root || !worktree.linked) continue;
        if (lockedFor(worktree) !== lockReason(taskId)) continue;
        let failure = '';
        if (git(root, ['worktree', 'unlock', root], (why) => (failure = why)) === undefined) {
          lines.push(`could not unlock the worktree ${root}: ${failure}`);
          left.push(root);
        } else lines.push(`unlocked the worktree ${root}`);
      }
      try {
        if (left.length !== roots.length) write(taskId, left);
      } catch (error) {
        lines.push(`could not update the record of locked worktrees: ${errorText(error)}`);
      }
      return lines;
    },

    tasks() {
      try {
        return readdirSync(dir)
          .filter((name) => name.endsWith('.json'))
          .map((name) => name.slice(0, -'.json'.length))
          .filter((id) => isSafeTaskId(id));
      } catch {
        return [];
      }
    },
  };
}
