/**
 * The PreToolUse hook of every run: `board internal hook <run dir> <task>`, with the hook input on stdin.
 * It touches the task's heartbeat and records the agent's working directory (a worktree it entered shows up here and is
 * locked for the task, see worktree-lock.mts). It makes no network call and never fails the tool call for its own errors:
 * a broken hook must not break a run.
 */
import { isRecord, isSafeTaskId, isSafeWorkdir } from '@agent-board/shared';
import { readStdin } from '../cli.mts';
import { createRunFiles } from './runtime.mts';
import { createWorktreeLocks } from './worktree-lock.mts';
import { errorText } from '../output/text.mts';

export async function runHook(args: string[]): Promise<void> {
  const [dir, taskId] = args;
  try {
    if (!dir || !taskId || !isSafeTaskId(taskId)) throw new Error('usage: board internal hook <run dir> <task>');
    const files = createRunFiles(dir);
    files.touchAlive(taskId);
    let input: unknown;
    try {
      input = JSON.parse(await readStdin());
    } catch {
      input = undefined;
    }
    if (isRecord(input) && typeof input['cwd'] === 'string' && isSafeWorkdir(input['cwd'])) {
      const cwd = input['cwd'];
      // A worktree the agent enters is locked for the task right away, not only once the run ends; the worker lets go of it
      // at the end unless the session stopped there.
      if (files.lastCwd(taskId) !== cwd) createWorktreeLocks().hold(taskId, cwd);
      files.writeCwd(taskId, cwd);
    }
  } catch (error) {
    // stderr of a hook that exits 0 only shows in verbose mode; the call goes ahead.
    console.error(`board internal hook: ${errorText(error)}`);
  }
}
