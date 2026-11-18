// The shapes a watch's name and PR must have before they reach a file name, argv or a message to the agent.
export { isWatchName } from '@agent-board/shared';

// What `gh` prints for a PR.
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

export function isPrUrl(url: string): boolean {
  return PR_URL.test(url);
}

// A GitHub login as gh prints it: a user, an app as a PR's author (`app/dependabot`) or a bot (`dependabot[bot]`).
const GH_LOGIN = /^(app\/)?[A-Za-z0-9][A-Za-z0-9_-]{0,99}(\[bot\])?$/;

export function isGhLogin(login: string): boolean {
  return GH_LOGIN.test(login);
}

// The node id of a review or a comment (`PRR_kwDO…`, `IC_kwDO…`).
const REVIEW_ITEM_ID = /^[A-Za-z0-9_=-]{1,120}$/;

export function isReviewItemId(id: string): boolean {
  return REVIEW_ITEM_ID.test(id);
}

// How many ids of reviews and comments a pr-review watch remembers.
export const MAX_SEEN_IDS = 200;

/** A ci watch's `settled` digest (see decideCi). */
export function isSettledDigest(digest: string): boolean {
  return /^[0-9a-f]{16}$/.test(digest);
}

export const MAX_IGNORE_PATTERNS = 20;
export const MAX_IGNORE_CHARS = 100;

/** A `--ignore` pattern: a check name with `*` for any run of characters, non-empty, short and without control characters. */
export function isIgnorePattern(pattern: string): boolean {
  return pattern.length > 0 && pattern.length <= MAX_IGNORE_CHARS && !/\p{Cc}/u.test(pattern);
}

/** The patterns of a stored ci watch, or undefined when `raw` is not a list of at most MAX_IGNORE_PATTERNS valid ones. */
export function parseIgnorePatterns(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_IGNORE_PATTERNS) return undefined;
  return raw.every((pattern): pattern is string => typeof pattern === 'string' && isIgnorePattern(pattern))
    ? raw
    : undefined;
}
