// What a task leaves on this machine after its runs: its log (logs.mts) and its session record (sessions.mts). The dispatcher
// lists them and drops those of finished tasks (see pruneTaskFiles in dispatch.mts).
//   <state dir>/logs/<task>.log
//   <state dir>/sessions/<task>
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeTaskId } from '@agent-board/shared';
import { getPaths } from '../config/config.mts';

export type TaskFileKind = 'log' | 'session';

export interface TaskFile {
  kind: TaskFileKind;
  taskId: string;
  modifiedAt: Date;
}

export interface TaskFileStore {
  // Every log and session record here, of any task.
  list(): TaskFile[];
  remove(file: Pick<TaskFile, 'kind' | 'taskId'>): void;
}

export function createTaskFileStore(
  { logDir, sessionDir }: { logDir: string; sessionDir: string } = getPaths(),
): TaskFileStore {
  const path = ({ kind, taskId }: Pick<TaskFile, 'kind' | 'taskId'>): string => {
    if (!isSafeTaskId(taskId)) throw new Error(`"${taskId.slice(0, 40)}" is not a task id`);
    return kind === 'log' ? join(logDir, `${taskId}.log`) : join(sessionDir, taskId);
  };
  // Only regular files named for a task: anything else in the directory is not ours to touch.
  const scan = (kind: TaskFileKind, dir: string, suffix: string): TaskFile[] => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      if (!name.endsWith(suffix)) return [];
      const taskId = name.slice(0, name.length - suffix.length);
      if (!isSafeTaskId(taskId)) return [];
      try {
        const stat = lstatSync(join(dir, name));
        return stat.isFile() ? [{ kind, taskId, modifiedAt: stat.mtime }] : [];
      } catch {
        return [];
      }
    });
  };
  return {
    list: () => [...scan('log', logDir, '.log'), ...scan('session', sessionDir, '')],
    remove(file) {
      rmSync(path(file), { force: true });
    },
  };
}
