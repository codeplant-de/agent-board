#!/usr/bin/env node
/**
 * The PreToolUse hook of every run: `agent-hook <run dir> <task>`, with the hook input on stdin.
 * It touches the task's heartbeat, records the agent's working directory (a worktree it entered shows up here), turns
 * AskUserQuestion into a question on the board (dormant: Claude Code 2.1.323 offers no AskUserQuestion to a headless run,
 * so the board's rules have the agent use `board ask` instead), and while a pause is requested it refuses every tool call but
 * `board comment`, telling the agent to post a status and end its turn. It never fails the tool call for its own errors: a broken
 * hook must not break a run.
 */
import { isRecord, isSafeTaskId, isSafeWorkdir, parseQuestions, QuestionError } from '@agent-board/shared';
import type { Question } from '@agent-board/shared';
import { buildContext, readStdin } from './cli.mts';
import { postSlack, slackText } from './notify.mts';
import { createRunFiles } from './runtime.mts';
import { oneLine } from './text.mts';

export const PAUSE_REASON =
  'Pause requested: this machine needs the slot for other work. Post a one-line status of where you are with `board comment <task> "..."`, then end your turn without any other tool call. You will be resumed later in this same session.';

// The only call let through during a pause: the status note the reason asks for. Anything chained to it is still
// checked part by part by Claude Code's own permission rules, so the text after `board comment` is not inspected
// (a status note may well contain a `;`).
export function allowedDuringPause(input: unknown): boolean {
  if (!isRecord(input) || input['tool_name'] !== 'Bash') return false;
  const toolInput = input['tool_input'];
  const command = isRecord(toolInput) ? toolInput['command'] : undefined;
  return typeof command === 'string' && /^board comment \S+ /.test(command.trim());
}

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

// What the hook prints for every call but AskUserQuestion: nothing to let the call run, or a deny decision.
export function hookDecision(input: unknown, pauseRequested: boolean, taskId: string): string {
  if (!pauseRequested || allowedDuringPause(input)) return '';
  return deny(PAUSE_REASON.replace('<task>', taskId));
}

if (import.meta.main) {
  const [dir, taskId] = process.argv.slice(2);
  try {
    if (!dir || !taskId || !isSafeTaskId(taskId)) throw new Error('usage: agent-hook <run dir> <task>');
    const files = createRunFiles(dir);
    files.touchAlive(taskId);
    let input: unknown;
    try {
      input = JSON.parse(await readStdin());
    } catch {
      input = undefined;
    }
    if (isRecord(input) && typeof input['cwd'] === 'string' && isSafeWorkdir(input['cwd']))
      files.writeCwd(taskId, input['cwd']);
    const pauseRequested = files.pauseRequestedAt(taskId) !== undefined;
    let decision = hookDecision(input, pauseRequested, taskId);
    if (!pauseRequested) {
      let questions: Question[] | undefined;
      let failure: string | undefined;
      try {
        questions = askedQuestions(input);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      if (questions !== undefined || failure !== undefined) {
        if (questions !== undefined) {
          try {
            const context = buildContext(false);
            await context.backend.ask(taskId, questions);
            // Best effort, as `board ask` does: the question is on the board either way.
            const first = questions[0]?.question ?? '';
            await context.backend
              .getTask(taskId)
              .then((task) =>
                postSlack(
                  context.config.slackWebhookFile,
                  slackText(
                    { title: task.title, url: context.taskLink(task.id) },
                    `Question: ${first}${questions && questions.length > 1 ? ` (+${questions.length - 1} more)` : ''}`,
                  ),
                ),
              )
              .catch(() => undefined);
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
          }
        }
        decision = askedDecision(taskId, failure);
      }
    }
    if (decision) process.stdout.write(decision);
  } catch (error) {
    // stderr of a hook that exits 0 only shows in verbose mode; the call goes ahead.
    console.error(`agent-hook: ${error instanceof Error ? error.message : String(error)}`);
  }
}
