// The Claude session this machine started for each task. The board names a task's session in the clear, so a worker resumes only
// the session found here: a session id the server made up, took from another task, or that a fresh run abandoned is never resumed.
//   <state dir>/sessions/<task>   the id of the session of the task's newest fresh run
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeTaskId, isSessionId } from '@agent-board/shared';
import { getPaths } from './config.mts';

export interface SessionStore {
  has(taskId: string, sessionId: string): boolean;
  // A fresh run: its session replaces every earlier one of the task, which can no longer be resumed.
  record(taskId: string, sessionId: string): void;
}

export function createSessionStore(dir: string = getPaths().sessionDir): SessionStore {
  const file = (taskId: string): string => {
    if (!isSafeTaskId(taskId)) throw new Error(`"${taskId.slice(0, 40)}" is not a task id`);
    return join(dir, taskId);
  };
  // An older file lists every session the task had, oldest first: the last is the current one.
  const current = (taskId: string): string | undefined => {
    const path = file(taskId);
    try {
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => isSessionId(line))
        .at(-1);
    } catch {
      return undefined;
    }
  };
  return {
    has: (taskId, sessionId) => current(taskId) === sessionId.toLowerCase(),
    record(taskId, sessionId) {
      if (!isSessionId(sessionId)) throw new Error('not a session id');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file(taskId), `${sessionId.toLowerCase()}\n`, { mode: 0o600 });
    },
  };
}
