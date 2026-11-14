// The Claude sessions this machine started, per task. The board names a task's session in the clear, so a worker resumes only
// a session found here: a session id the server made up, or took from another task, is never resumed.
//   <state dir>/sessions/<task>   one session id per line, oldest first
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeTaskId, isSessionId } from '@agent-board/shared';
import { getPaths } from './config.mts';

// A task runs a handful of fresh sessions in its life; the newest are kept.
const KEEP = 50;

export interface SessionStore {
  has(taskId: string, sessionId: string): boolean;
  record(taskId: string, sessionId: string): void;
}

export function createSessionStore(dir: string = getPaths().sessionDir): SessionStore {
  const file = (taskId: string): string => {
    if (!isSafeTaskId(taskId)) throw new Error(`"${taskId.slice(0, 40)}" is not a task id`);
    return join(dir, taskId);
  };
  const read = (taskId: string): string[] => {
    const path = file(taskId);
    try {
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => isSessionId(line));
    } catch {
      return [];
    }
  };
  return {
    has: (taskId, sessionId) => read(taskId).includes(sessionId.toLowerCase()),
    record(taskId, sessionId) {
      if (!isSessionId(sessionId)) throw new Error('not a session id');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const known = read(taskId);
      const entry = sessionId.toLowerCase();
      if (known.length >= KEEP)
        writeFileSync(file(taskId), `${[...known.slice(-(KEEP - 1)), entry].join('\n')}\n`, { mode: 0o600 });
      else appendFileSync(file(taskId), `${entry}\n`, { mode: 0o600 });
    },
  };
}
