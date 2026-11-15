// A polish note: the agent's proposal for a backlog task's new title and prompt, written on its own task's thread. The
// user applies it in the browser, which seals the text as theirs; nothing here ever changes a task.
import { ContractError, isSafeTaskId, SEALED_LIMITS } from './contract.mts';
import { isRecord } from './guards.mts';

export interface Polish {
  /** The task whose title and prompt this suggests; the applying client checks it is the suggesting task's parent. */
  target: string;
  title: string;
  prompt: string;
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

function checkSize(what: string, text: string, limit: number): void {
  const size = utf8Bytes(text);
  if (size > limit)
    throw new ContractError(`the ${what} is too long: ${size} bytes of UTF-8, and the board takes at most ${limit}`);
}

/** Checks a polish against what the board takes for a title and a prompt; the title is one line. */
export function checkPolish(polish: Polish): Polish {
  const title = polish.title.trim();
  const prompt = polish.prompt.trim();
  if (!isSafeTaskId(polish.target)) throw new ContractError('the polish needs the id of the task it is for');
  if (title === '') throw new ContractError('the polished title is empty');
  if (/[\r\n]/.test(title)) throw new ContractError('the polished title must be one line');
  if (prompt === '') throw new ContractError('the polished prompt is empty');
  checkSize('title', title, SEALED_LIMITS.title);
  checkSize('prompt', prompt, SEALED_LIMITS.input);
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
