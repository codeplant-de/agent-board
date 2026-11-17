// The shapes a watch's name and PR must have before they reach a file name, argv or a message to the agent.
export { isWatchName } from '@agent-board/shared';

// What `gh` prints for a PR.
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

export function isPrUrl(url: string): boolean {
  return PR_URL.test(url);
}
