// The shapes a watch's name and PR must have before they reach a file name, argv or a message to the agent.
export const MAX_WATCH_NAME_CHARS = 32;
const WATCH_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isWatchName(name: string): boolean {
  return WATCH_NAME.test(name);
}

// What `gh` prints for a PR.
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

export function isPrUrl(url: string): boolean {
  return PR_URL.test(url);
}
