// What a task's prompt says: the PR it names and the title it gets by default.

export function parsePrUrl(url: string): { repo: string; number: number } | undefined {
  const match = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)\/?$/.exec(url);
  if (!match?.[1] || !match[2]) return undefined;
  return { repo: match[1], number: Number(match[2]) };
}

// The first GitHub PR URL in the prompt's first line: the PR a review task works on.
export function prUrlIn(input: string): string | undefined {
  const first = input.split('\n')[0] ?? '';
  return /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.exec(first)?.[0];
}

// The first line of a prompt, shortened.
export function defaultTitle(prompt: string): string {
  const first = prompt.trim().split('\n')[0]?.trim() ?? '';
  return first.length > 100 ? `${first.slice(0, 99)}…` : first;
}
