/**
 * The PreToolUse hook of every run: `board internal hook <run dir> <task>`, with the hook input on stdin.
 * It touches the task's heartbeat, records the agent's working directory (a worktree it entered shows up here and is locked
 * for the task, see worktree-lock.mts), turns
 * AskUserQuestion into a question on the board (dormant: Claude Code 2.1.323 offers no AskUserQuestion to a headless run,
 * so the board's rules have the agent use `board ask` instead). It never fails the tool call for its own errors: a broken
 * hook must not break a run.
 */
import { isRecord, isSafeTaskId, isSafeWorkdir, parseQuestions, QuestionError } from '@agent-board/shared';
import type { Question } from '@agent-board/shared';
import { buildContext, readStdin } from '../cli.mts';
import { createRunFiles } from './runtime.mts';
import { createWorktreeLocks } from './worktree-lock.mts';
import { errorText, oneLine } from '../output/text.mts';

function deny(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  });
}

/**
 * The questions of an AskUserQuestion call in the board's shape, or undefined for any other call. Claude Code marks the
 * recommended option by ending its label with "(Recommended)"; the board has a flag for it.
 */
export function askedQuestions(input: unknown): Question[] | undefined {
  if (!isRecord(input) || input['tool_name'] !== 'AskUserQuestion') return undefined;
  const toolInput = input['tool_input'];
  const raw = isRecord(toolInput) ? toolInput['questions'] : undefined;
  if (!Array.isArray(raw)) throw new QuestionError('AskUserQuestion without questions');
  const questions = raw.map((question: unknown) => {
    if (!isRecord(question) || !Array.isArray(question['options'])) return question;
    const options = question['options'].map((option: unknown) => {
      if (!isRecord(option) || typeof option['label'] !== 'string') return option;
      const marked = /\s*\(recommended\)\s*$/i.test(option['label']);
      return {
        label: option['label'].replace(/\s*\(recommended\)\s*$/i, ''),
        description: typeof option['description'] === 'string' ? option['description'] : '',
        ...(marked ? { recommended: true } : {}),
      };
    });
    return { ...question, options };
  });
  return parseQuestions(questions);
}

export function askedDecision(taskId: string, failure: string | undefined): string {
  if (failure !== undefined) {
    return deny(
      `Could not put the question on the board (${oneLine(failure, 400)}). Post the question with \`board comment ${taskId} "..."\`, then run \`board move ${taskId} needs-me\` and end your turn.`,
    );
  }
  return deny(
    'The question is on the board now; the user answers it there. End your turn without any other tool call. You will be resumed in this session with the answers.',
  );
}

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
    let questions: Question[] | undefined;
    let failure: string | undefined;
    try {
      questions = askedQuestions(input);
    } catch (error) {
      failure = errorText(error);
    }
    if (questions === undefined && failure === undefined) return;
    if (questions !== undefined) {
      try {
        const context = buildContext(false);
        await context.backend.ask(taskId, questions);
      } catch (error) {
        failure = errorText(error);
      }
    }
    process.stdout.write(askedDecision(taskId, failure));
  } catch (error) {
    // stderr of a hook that exits 0 only shows in verbose mode; the call goes ahead.
    console.error(`board internal hook: ${errorText(error)}`);
  }
}
