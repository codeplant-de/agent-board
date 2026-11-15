// What a task's prompt says: the PR it names and the title it gets by default.

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

// The PR to show for a task: the one its prompt names, else the one its agent reported (`board pr`).
export function prOf(task: { input: string; pr: string | null }): string | undefined {
  return prUrlIn(task.input) ?? task.pr ?? undefined;
}

// The PR whose state a task shows: the one its agent reported, else the one its prompt names.
export function statePrOf(task: { input: string; pr: string | null }): string | undefined {
  return task.pr ?? prUrlIn(task.input);
}

// The first line of a prompt, shortened.
export function defaultTitle(prompt: string): string {
  const first = prompt.trim().split('\n')[0]?.trim() ?? '';
  return first.length > 100 ? `${first.slice(0, 99)}…` : first;
}
