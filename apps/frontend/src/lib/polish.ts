import { isSafeMachineName, isSafeWorkdir, parsePolish, type Status, type Polish } from '@agent-board/shared';
import type { NewTask } from './sealing';
import type { BoardTask, ThreadNote } from './trpc';

const TITLE_PREFIX = 'Polish prompt: ';
const TITLE_MAX_CHARS = 80;

/** Where a polished prompt can be applied: a task that waits for you. */
const APPLIES_IN: readonly Status[] = ['backlog', 'needs-me'];

type Polishable = Pick<BoardTask, 'status' | 'closed' | 'createdBy' | 'scheduleId' | 'unreadable'>;

/** Only a Backlog task you wrote and can read is polished: the rewrite has to be applied to it as yours. */
export function canPolish(task: Polishable): boolean {
  return (
    task.status === 'backlog' &&
    !task.closed &&
    task.createdBy === 'user' &&
    task.scheduleId === null &&
    task.unreadable.length === 0
  );
}

function shortTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length > TITLE_MAX_CHARS ? `${chars.slice(0, TITLE_MAX_CHARS - 1).join('')}…` : title;
}

export function polishPrompt(taskId: string): string {
  return [
    `Polish the prompt of board task ${taskId}. Read it with \`board show ${taskId}\`, including its notes and its parent.`,
    '',
    'Turn the rough idea into a complete task that an agent can pick up later, when the context is gone. First gather context:',
    '- Find what the task is about: the repository, feature, PR, story, doc or earlier board task it names or implies. Read enough of it to understand how things work today.',
    '- Fill the gaps from what you find: what exists now, what is missing, which parts are affected. Settle what the evidence settles.',
    '',
    'Then write the new prompt as a light, high-level plan in product language:',
    '- The goal and why it matters, then how it works today and what should change, then the steps in the order they make sense, then what done looks like.',
    '- Describe behaviour and outcomes a user would notice, not code. Name a file, command or component only where it points the agent to the right place.',
    '- Keep every idea and detail the user wrote. Where you had to decide something the user did not say, mark it as an assumption; list what only the user can answer under "Open questions".',
    '- Keep a leading slash command and its arguments exactly as they are.',
    '- Keep it short: a plan to start from, not a design document.',
    'Also write a short title.',
    '',
    `Do not start the work the prompt describes: read, do not edit, and do not change task ${taskId}. Write the new prompt to a file in /tmp and post it from this run with \`board polish ${taskId} --title "<title>" --file <path>\`. Then end with a one-line comment.`,
  ].join('\n');
}

/**
 * The task that asks an agent to polish `target`'s prompt, as its child with the same priority. When `target` has a directory
 * of its own (it was scheduled from a checkout), the polish runs there on the same machine, so the agent starts in the code
 * the idea is about; otherwise in the default directory of whichever machine takes it.
 */
export function polishTask(target: Pick<BoardTask, 'id' | 'title' | 'priority' | 'machine' | 'workdir'>): NewTask {
  const { machine, workdir } = target;
  const placed = machine !== null && workdir !== null && isSafeMachineName(machine) && isSafeWorkdir(workdir);
  return {
    title: `${TITLE_PREFIX}${shortTitle(target.title)}`,
    input: polishPrompt(target.id),
    priority: target.priority,
    parentId: target.id,
    ...(placed ? { place: { machine, workdir } } : {}),
  };
}

/** A task of yours that polishes `parentId` and is not finished yet, so another one would only repeat it. */
export function isOpenPolishOf(
  task: Pick<BoardTask, 'title' | 'createdBy' | 'status' | 'closed' | 'parentId'>,
  parentId: string,
): boolean {
  return (
    task.parentId === parentId &&
    task.createdBy === 'user' &&
    task.title.startsWith(TITLE_PREFIX) &&
    task.status !== 'done' &&
    !task.closed
  );
}

export type PolishState = { usable: true; rewrite: Polish; target: BoardTask } | { usable: false; reason: string };

/**
 * Whether a polish note can be applied from the task page of the task that wrote it: it must be a polished prompt for exactly
 * this task's parent, and the parent must still wait for you, as yours.
 */
export function polishState(polish: BoardTask, parent: BoardTask | null, note: ThreadNote): PolishState {
  const rewrite = parsePolish(note.text);
  if (note.author !== 'agent' || rewrite === undefined)
    return { usable: false, reason: 'This is not a polished prompt this browser understands.' };
  if (parent === null || polish.parentId !== parent.id)
    return { usable: false, reason: 'This task has no parent to apply it to.' };
  if (rewrite.target !== parent.id)
    return { usable: false, reason: `It is for task ${rewrite.target}, not for this task’s parent.` };
  if (parent.closed || !APPLIES_IN.includes(parent.status))
    return { usable: false, reason: `“${parent.title}” is no longer in Backlog or Needs me.` };
  if (parent.createdBy !== 'user' || parent.scheduleId !== null)
    return { usable: false, reason: `“${parent.title}” is not a task you wrote, so a prompt cannot be applied to it.` };
  if (parent.unreadable.length > 0)
    return { usable: false, reason: `“${parent.title}” cannot be read, so what it says now could not be kept.` };
  return { usable: true, rewrite, target: parent };
}
