// What a task's prompt says: the PR it names and the title it gets by default.
import type { PrState, TaskPr } from './contract.mts';

export function parsePrUrl(url: string): { repo: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/.exec(url);
  if (!match?.[1] || !match[2]) return undefined;
  return { repo: match[1], number: Number(match[2]) };
}

// A GitHub pull request URL: the characters GitHub allows in an owner and a repository name, and a number.
const PR_URL = String.raw`https://github\.com/[\w.-]+/[\w.-]+/pull/\d+`;

// The first GitHub PR URL in the prompt's first line: the PR a review task works on.
export function prUrlIn(input: string): string | undefined {
  const first = input.split('\n')[0] ?? '';
  return new RegExp(PR_URL).exec(first)?.[0];
}

// Whether `value` is a GitHub PR URL and nothing else.
export function isPrUrl(value: string): boolean {
  return new RegExp(`^${PR_URL}$`).test(value);
}

/**
 * A pull request of a task as it is shown and refreshed: `id` is the row of a reported one, absent for one only the prompt names.
 * `prompt` is true for the PR the prompt names, also when the agent reported it too and `id` is set.
 */
export interface ShownPr {
  url: string;
  state: PrState | null;
  id?: string;
  prompt: boolean;
}

/**
 * The PRs to show for a task: the one its prompt names first, then the ones its agent reported (`board pr`) in order, each URL
 * once. A prompt PR that was also reported is the reported row, with its state, else the one the prompt PR has.
 */
export function prsOf(task: { input: string; prs: readonly TaskPr[]; promptPrState: PrState | null }): ShownPr[] {
  const shown: ShownPr[] = [];
  const promptUrl = prUrlIn(task.input);
  if (promptUrl !== undefined) shown.push({ url: promptUrl, state: task.promptPrState, prompt: true });
  for (const { id, url, state } of task.prs) {
    const same = shown.find((pr) => pr.url === url);
    if (same === undefined) shown.push({ url, state, id, prompt: false });
    else if (same.id === undefined) {
      same.id = id;
      same.state = state ?? same.state;
    }
  }
  return shown;
}

// The first line of a prompt, shortened.
export function defaultTitle(prompt: string): string {
  const first = prompt.trim().split('\n')[0]?.trim() ?? '';
  return first.length > 100 ? `${first.slice(0, 99)}…` : first;
}

/** `text` in a code fence long enough that nothing inside it closes the fence. */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

function keptText(label: string, target: { title: string; input: string }): string {
  return `${label}\n\nTitle: ${target.title}\n\n${fenced(target.input)}`;
}

/** The note that keeps what a polished prompt replaces, so applying it loses nothing. */
export function previousText(target: { title: string; input: string }): string {
  return keptText('Prompt before polishing', target);
}

/** The note that keeps what an edit of the prompt replaces. */
export function textBeforeEdit(target: { title: string; input: string }): string {
  return keptText('Prompt before editing', target);
}
