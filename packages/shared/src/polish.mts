// A polish note: the agent's proposal for a backlog task's new title and prompt, written on its own task's thread. The
// user applies it in the browser, which seals the text as theirs; nothing here ever changes a task. The task that asks for
// one is built here too, so the board's "Polish prompt" button and `board schedule --polish` queue the same task.
import { checkSealedSize, ContractError, isSafeMachineName, isSafeTaskId, isSafeWorkdir } from './contract.mts';
import type { Priority } from './contract.mts';
import { isRecord } from './guards.mts';

/** The start of a polish task's title; the board tells an open polish of a task by it. */
export const POLISH_TITLE_PREFIX = 'Polish prompt: ';
const POLISH_TITLE_MAX_CHARS = 80;

function shortTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length > POLISH_TITLE_MAX_CHARS ? `${chars.slice(0, POLISH_TITLE_MAX_CHARS - 1).join('')}…` : title;
}

/** The instructions of a polish task: rewrite `taskId`'s prompt as a plan and post it with `board polish`. */
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

export interface PolishTarget {
  id: string;
  title: string;
  priority: Priority;
  machine: string | null;
  workdir: string | null;
}

/** A polish task before it is sealed; the caller creates it as the user's, in Todo. */
export interface PolishTask {
  title: string;
  input: string;
  priority: Priority;
  parentId: string;
  /** Absent: the default directory of whichever machine takes it. */
  place?: { machine: string; workdir: string };
}

/**
 * The task that asks an agent to polish `target`'s prompt, as its child with the same priority. When `target` has a directory
 * of its own (it was scheduled from a checkout), the polish runs there on the same machine, so the agent starts in the code
 * the idea is about; otherwise in the default directory of whichever machine takes it.
 */
export function polishTask(target: PolishTarget): PolishTask {
  const { machine, workdir } = target;
  const placed = machine !== null && workdir !== null && isSafeMachineName(machine) && isSafeWorkdir(workdir);
  return {
    title: `${POLISH_TITLE_PREFIX}${shortTitle(target.title)}`,
    input: polishPrompt(target.id),
    priority: target.priority,
    parentId: target.id,
    ...(placed ? { place: { machine, workdir } } : {}),
  };
}

export interface Polish {
  /** The task whose title and prompt this suggests; the applying client checks it is the suggesting task's parent. */
  target: string;
  title: string;
  prompt: string;
}

/** Checks a polish against what the board takes for a title and a prompt; the title is one line. */
export function checkPolish(polish: Polish): Polish {
  const title = polish.title.trim();
  const prompt = polish.prompt.trim();
  if (!isSafeTaskId(polish.target)) throw new ContractError('the polish needs the id of the task it is for');
  if (title === '') throw new ContractError('the polished title is empty');
  if (/[\r\n]/.test(title)) throw new ContractError('the polished title must be one line');
  if (prompt === '') throw new ContractError('the polished prompt is empty');
  checkSealedSize('title', title, 'the title');
  checkSealedSize('input', prompt, 'the prompt');
  return { target: polish.target, title, prompt };
}

/** The text a polish note carries (sealed as its body). */
export const serializePolish = (polish: Polish): string => JSON.stringify(checkPolish(polish));

/** Reads the text of an opened polish note; undefined when it is not exactly a polish. */
export function parsePolish(text: string): Polish | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(json)) return undefined;
  const { target, title, prompt, ...rest } = json;
  if (Object.keys(rest).length > 0) return undefined;
  if (typeof target !== 'string' || typeof title !== 'string' || typeof prompt !== 'string') return undefined;
  try {
    return checkPolish({ target, title, prompt });
  } catch (error) {
    if (error instanceof ContractError) return undefined;
    throw error;
  }
}
