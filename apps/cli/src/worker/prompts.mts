import { formatAnswers } from '@agent-board/shared';
import type { Note, Task } from '@agent-board/shared';
import { START_MARKER, WAKE_MARKER } from '../task-rules.mts';

const byTime = (notes: Note[]): Note[] => [...notes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

// What the user wrote: answers to the agent's questions and free comments.
const userNotes = (notes: Note[]): Note[] =>
  notes.filter((note) => note.author === 'user' && (note.kind === 'answer' || note.kind === 'comment'));

/**
 * The user's reply, oldest first: what they wrote since the agent last spoke, and the messages they sent the running agent
 * since the previous run started that it was never handed (they may sit before the agent's last note). Without what the agent
 * already got while the run went on. `runStartedAt` is when this run was claimed.
 */
export function userReply(notes: Note[], runStartedAt: Date | null = null): Note[] {
  const sorted = byTime(notes);
  const lastStart = previousRunStart(notes, runStartedAt);
  const spoken = userNotes(sorted.slice(sorted.findLastIndex((note) => note.author === 'agent') + 1));
  const queued = userNotes(
    sorted.filter((note) => note.queued === true && (lastStart === undefined || note.createdAt > lastStart)),
  );
  const seen = new Set<string>();
  return byTime([...spoken, ...queued]).filter((note) => {
    if (note.deliveredAt !== undefined || seen.has(note.id)) return false;
    seen.add(note.id);
    return true;
  });
}

// A message of the user's, as the running agent gets it. After an interruption it is the correction to what it was doing.
export function inboxMessageText(taskId: string, note: Note, afterInterrupt: boolean): string {
  const lead = afterInterrupt
    ? `The user interrupted you on board task ${taskId} to correct you:`
    : `The user sent you a message on board task ${taskId} while you work:`;
  return `${lead}\n\n${noteText(note)}`;
}

// What the agent is told when its lane's slot is needed; it ends its turn and is resumed in this session.
export function pauseMessageText(taskId: string): string {
  return `Pause requested: this machine needs the slot for other work. Post a one-line status of where you are with \`board comment ${taskId} "..."\`, then end your turn without any other tool call. You will be resumed later in this same session.`;
}

// A note as the agent reads it; an answer comes with the questions the user was shown, from its own envelope.
function noteText(note: Note): string {
  if (note.kind !== 'answer') return note.text.trim();
  const answers = formatAnswers(note.questions, note.answers ?? []);
  return note.text.trim() === '' ? `Answers:\n${answers}` : `Answers:\n${answers}\n\n${note.text.trim()}`;
}

// When the run before this one started, from the dispatcher's start notes; `before` is when this run was claimed.
function previousRunStart(notes: Note[], before: Date | null): Date | undefined {
  const starts = notes.filter(
    (note) =>
      note.author === 'system' && note.text.startsWith(START_MARKER) && (before === null || note.createdAt < before),
  );
  return starts.map((note) => note.createdAt).sort((a, b) => b.getTime() - a.getTime())[0];
}

// What the user wrote since the previous run started, oldest first: what a fresh run is told of the thread.
export function writtenSincePreviousRun(task: Task, notes: Note[]): Note[] {
  const lastStart = previousRunStart(notes, task.runStartedAt);
  return byTime(userNotes(notes.filter((note) => lastStart === undefined || note.createdAt > lastStart)));
}

/**
 * What a fresh run is told of the thread on top of its prompt: the user's notes since the previous run started, as
 * written, and where to read the rest. Undefined when only the board wrote to the thread.
 */
export function freshThreadBlock(task: Task, notes: Note[]): string | undefined {
  if (!notes.some((note) => note.author !== 'system' && note.author !== 'server')) return undefined;
  const written = writtenSincePreviousRun(task, notes);
  return [
    ...(written.length > 0
      ? [
          `The user wrote on board task ${task.id} since its last run started:`,
          '',
          ...written.flatMap((note) => [noteText(note), '']),
        ]
      : []),
    `The thread holds earlier notes: run \`board show ${task.id}\` first to read it.`,
  ].join('\n');
}

const CONTINUE_LINE = "The board's rules from the start of this session still hold.";

// Why the wait ended, from the wake note a machine wrote after the agent last spoke; none means the user ended it. Only its first
// paragraph: the rest is the end of the check's output, which can carry text the user did not write (a PR's job names), and the
// prompt is the user's turn. It stays in the thread.
function wokenLine(task: Task, notes: Note[]): string {
  const sorted = byTime(notes);
  const since = sorted.slice(sorted.findLastIndex((note) => note.author === 'agent') + 1);
  const wake = since.findLast(
    (note) => note.author === 'system' && !note.unreadable && note.text.startsWith(WAKE_MARKER),
  );
  const why =
    wake === undefined
      ? 'the user ended it early.'
      : wake.text.slice(WAKE_MARKER.length).split('\n\n')[0]?.trim() || 'its time ran out.';
  return `Your wait on board task ${task.id} is over: ${why}\n\nCheck the state of what you waited for, then go on with the task.`;
}

export function buildResumePrompt(task: Task, notes: Note[]): string | undefined {
  const reply = userReply(notes, task.runStartedAt);
  const paused = task.paused;
  const woken = task.woken;
  if (reply.length === 0 && !paused && !woken) return undefined;
  const pausedLine = `You were paused on board task ${task.id} to free the slot for other work. Continue where you left off; check the state of anything you were in the middle of before you go on.`;
  const lead = [...(woken ? [wokenLine(task, notes), ''] : []), ...(paused ? [pausedLine, ''] : [])];
  if (reply.length === 0) {
    return [...lead, CONTINUE_LINE].join('\n');
  }
  const parts = reply.map((note) => noteText(note));
  return [
    ...lead,
    `The user replied on board task ${task.id}:`,
    '',
    ...parts.flatMap((part) => [part, '']),
    `Continue the task with this. ${CONTINUE_LINE}`,
  ].join('\n');
}

// What every run is told about the board, on top of its prompt.
export function boardRules(task: Task): string {
  return [
    `You are running headless as agent-board task ${task.id}. Nobody watches this terminal; the user reads the task's thread on the board.`,
    `- Report progress and results with \`board comment ${task.id} "<text>"\` (markdown; \`--file <path>\` for long text in /tmp, or \`-\` for stdin).`,
    `- AskUserQuestion is not available in this headless run. Wherever you would use it, also where a skill says to: write the same questions with the Write tool to /tmp/pr-${task.id}-questions.json as {"questions": [{"header": "<at most 16 chars>", "question": "...", "multiSelect": false, "options": [{"label": "...", "description": "...", "recommended": true}, ...]}]} (1 to 4 questions, 2 to 4 options each, at most one recommended), run \`board ask ${task.id} --file /tmp/pr-${task.id}-questions.json\`, then end your turn. The user answers on the board, and you are resumed in this session with the answers.`,
    `- When the work is done, post a short summary with \`board comment\`, then \`board move ${task.id} needs-me\`. Attach to that comment the reply you expect the user to send next, in their voice (for example a go-ahead for your proposed next step): \`board comment --suggest "<reply>" ${task.id} "<summary>"\`. Skip it when no single reply is obvious, and if the board refuses \`--suggest\`, post the comment without it.`,
    `- To suggest follow-up work, write it to a file in /tmp and run \`board add --title "<title>" --file <path> --parent ${task.id}\`; the user starts it.`,
    '- Do not end your turn while a background agent or background command you started is still running: this run ends when your turn does. Run subagents in the foreground, or wait for their result before ending your turn.',
    '- If you are told that a pause was requested, post a one-line status with `board comment` and end your turn; you will be resumed here.',
    '- The user may send you a message while you work, or interrupt you with a correction. Take it as the latest instruction on the task.',
    ...(task.createdBy === 'intake'
      ? []
      : [
          `- Work on your own. Decide and act without asking on whatever is easy to undo and stays on this machine: reading, editing files, running tests and builds, local branches, worktrees and commits, scratch files in /tmp. Where the prompt leaves a gap, make a reasonable choice and name it in your report. Use \`board ask\` only before a step that is hard to undo or that other people see, unless the prompt asked for that step: force-pushing, deleting branches or data, merging, deploying, posting to Slack, Shortcut, email or someone else's PR or issue.`,
          `- A prompt that asks you to implement, fix or change code in a git repository is the user's request to commit, push and open a PR, and the result it expects is that PR. Work on a new branch, never the default branch; if the checkout holds changes that are not yours, work in a new git worktree. Commit, push with \`git push -u origin HEAD\`, and open the PR with \`gh pr create\`. If the repository's CI has to be started or approved by hand (its CLAUDE.md or skills say so and how), start it; otherwise CI runs on push. Wait for CI as the next rule says, and fix what fails. Put the PR link in your final \`board comment\`. A task that asks only for a plan, an investigation or a review opens no PR.`,
          `- Right after you open a pull request for this task, run \`board pr ${task.id} <url>\`: the board shows it on the task's card and page. A later PR replaces the earlier one.`,
          `- When you have to wait for something outside that takes minutes or longer (CI, a deploy, a review), do not sleep or poll in this run: run \`board wait ${task.id} --check '<command>' --reason "<what you wait for>"\` with a command that exits 0 once the wait is over (\`--every <dur>\` how often it runs, default 2m; \`--timeout <dur>\` when to give up, default 2h), or \`board wait ${task.id} --in 30m --reason "<what you wait for>"\` for a plain timer, then end your turn. The task frees its slot, and you are resumed in this session when the check passes or the time is up.`,
        ]),
    ...(task.createdBy === 'intake'
      ? [
          "- This run allows only a fixed list of commands, and each matches only when it stands alone: run every Bash command on its own, without pipes, `;`, `&&`, redirects or `cd`, by its full path, and filter output with the command's own options. A refused call is a result; report it instead of working around it, and go on with the other steps.",
        ]
      : []),
  ].join('\n');
}

/** Told to a resumed session whose directory is gone, ahead of the reply: it has to get back to its worktree itself. */
export function goneDirNotice(gone: string, checkout: string): string {
  return `The directory this session last worked in, ${gone}, no longer exists on this machine (it was deleted, for example when its worktree was cleaned up). This run continues the same session in ${checkout}, the git checkout that held it. Anything in ${gone} that was not committed and pushed is lost. Before you change any files, get back to where you were working: if it was a git worktree, recreate it on its branch the way this repository creates worktrees (see its CLAUDE.md) and move into it, then check that the branch still has your last commits (locally or on the remote), and say in your next board comment which commit you continue from. If the branch is gone as well, say so with \`board comment\` and ask the user how to go on instead of working in this checkout.`;
}
