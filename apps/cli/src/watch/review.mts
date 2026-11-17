// The pr-review source: the reviews and comments of a PR, read with `gh pr view`. What to make of what gh said is a pure function.
import { isRecord } from '@agent-board/shared';
import { shellQuote } from '../output/text.mts';
import type { GhOutput } from './ci.mts';
import { EVENT_TEXT_MAX_CHARS } from './fence.mts';
import { isGhLogin, isReviewItemId, MAX_SEEN_IDS } from './shapes.mts';
import type { WatchSource } from './store.mts';

export type ReviewSource = Extract<WatchSource, { kind: 'pr-review' }>;

export interface ReviewInput {
  source: ReviewSource;
  // `gh pr view <pr> --json url,state,author,reviews,comments`.
  view: GhOutput;
}

export type ReviewDecision =
  // The watch ends with this text.
  | { kind: 'event'; text: string }
  | { kind: 'pending'; summary: string; source: ReviewSource }
  // gh could not tell (auth, an unknown PR, the network).
  | { kind: 'error'; reason: string };

export const reviewViewCommand = (pr: string): string =>
  `gh pr view ${shellQuote(pr)} --json url,state,author,reviews,comments`;

// What one event names at the most, and how much of each body it quotes.
const MAX_EVENT_ITEMS = 3;
const MAX_BODY_LINES = 4;
const MAX_BODY_CHARS = 400;

interface Item {
  id: string;
  // The author's login as gh printed it, when it has the shape of one.
  login: string | undefined;
  // Epoch ms of `submittedAt` (a review) or `createdAt` (a comment).
  time: number;
  // A review's state (APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED); undefined for a comment.
  state: string | undefined;
  body: string;
  // A comment's link, when it is one below the PR.
  url: string | undefined;
}

function firstLine(text: string, fallback: string): string {
  return (
    text
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? fallback
  );
}

function loginOf(author: unknown): string | undefined {
  const login = isRecord(author) ? author['login'] : undefined;
  return typeof login === 'string' && isGhLogin(login) ? login : undefined;
}

/**
 * A login as it compares: gh names an app `app/dependabot` as a PR's author and `dependabot` (or `dependabot[bot]`) as the author
 * of its reviews and comments.
 */
export function sameActor(login: string): string {
  return login
    .toLowerCase()
    .replace(/^app\//, '')
    .replace(/\[bot\]$/, '');
}

// The reviews and comments gh listed, oldest first. An entry without an id or a time cannot be told apart later and is left
// out, as is a review that is not submitted yet (the viewer's own draft).
function parseItems(info: Record<string, unknown>, pr: string): Item[] | undefined {
  const { reviews, comments } = info;
  if (!Array.isArray(reviews) || !Array.isArray(comments)) return undefined;
  const items: Item[] = [];
  const add = (entry: unknown, timeKey: string, review: boolean): void => {
    if (!isRecord(entry)) return;
    const { id, body, state, url } = entry;
    const time = typeof entry[timeKey] === 'string' ? Date.parse(entry[timeKey]) : Number.NaN;
    if (typeof id !== 'string' || !isReviewItemId(id) || Number.isNaN(time)) return;
    if (review && state === 'PENDING') return;
    items.push({
      id,
      login: loginOf(entry['author']),
      time,
      state: review ? (typeof state === 'string' ? state : '') : undefined,
      body: typeof body === 'string' ? body : '',
      url: typeof url === 'string' && /^#issuecomment-\d{1,20}$/.test(url.slice(pr.length)) ? url : undefined,
    });
  };
  for (const review of reviews) add(review, 'submittedAt', true);
  for (const comment of comments) add(comment, 'createdAt', false);
  return items.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}

const REVIEW_STATES: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'reviewed with comments',
  DISMISSED: 'left a review that was dismissed',
};

// A line that is one whole HTML comment, such as a bot's marker. This shortens the excerpt and filters nothing: what the
// excerpt keeps is sanitized like any event text.
const isMarkerLine = (line: string): boolean => line.length >= 7 && line.startsWith('<!--') && line.endsWith('-->');

// The first lines of a body: blank lines and marker lines are passed over.
function excerpt(body: string): string[] {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !isMarkerLine(line));
  const kept: string[] = [];
  let room = MAX_BODY_CHARS;
  for (const line of lines.slice(0, MAX_BODY_LINES)) {
    if (room <= 0) break;
    kept.push(line.length > room ? `${line.slice(0, room - 1)}…` : line);
    room -= line.length;
  }
  if (kept.length < lines.length && !(kept.at(-1) ?? '').endsWith('…')) kept.push('…');
  return kept;
}

function describeItem({ login, state, body, url }: Item): string[] {
  const who = login ?? 'someone';
  const lines = excerpt(body);
  if (state === undefined)
    return [`${who} commented${url === undefined ? '' : ` (${url})`}:`, ...(lines.length > 0 ? lines : ['(no text)'])];
  return [
    `${who} ${REVIEW_STATES[state] ?? 'reviewed'}:`,
    ...(lines.length > 0 ? lines : ['(no review text; any comments are on the lines of the diff)']),
  ];
}

/** The text of the event for `items`, oldest first: who, the review state, and the first lines of each body. */
export function reviewEventText(url: string, items: Item[]): string {
  const shown = items.slice(0, MAX_EVENT_ITEMS);
  const more = items.length - shown.length;
  const lines = [`New on ${url}:`, ...shown.flatMap(describeItem), ...(more > 0 ? [`and ${more} more.`] : [])];
  // The fence keeps the end of a text that is too long; this one says who at its start.
  return lines.join('\n').slice(0, EVENT_TEXT_MAX_CHARS);
}

// What the watch remembers of `items`: the newest ids, and when there are more than it keeps, the time before which everything
// counts as seen.
function remember(source: ReviewSource, items: Item[]): ReviewSource {
  const kept = items.slice(-MAX_SEEN_IDS);
  const oldest = kept[0];
  const { seenBefore: _before, ...rest } = source;
  return {
    ...rest,
    seen: kept.map(({ id }) => id),
    ...(items.length > kept.length && oldest !== undefined ? { seenBefore: new Date(oldest.time).toISOString() } : {}),
  };
}

/**
 * What a PR's reviews and comments say. The first look only remembers what is there. After it, a review or comment the watch has
 * not seen, written by someone other than the PR's author and this machine's gh user, ends the watch; so does a PR that was
 * merged or closed. Logins and bodies in the text are written by someone else and not to be trusted: the caller sanitizes the
 * text and hands it over inside the fence.
 */
export function decideReview({ source, view }: ReviewInput): ReviewDecision {
  if (view.exitCode !== 0) return { kind: 'error', reason: firstLine(view.stderr, 'gh pr view failed') };
  let info: unknown;
  try {
    info = JSON.parse(view.stdout);
  } catch {
    return { kind: 'error', reason: 'gh pr view printed something that is not JSON' };
  }
  if (!isRecord(info)) return { kind: 'error', reason: 'gh pr view printed something unexpected' };
  const { state } = info;
  // The URL the watch was registered with is shape-checked; what gh prints now is not.
  const url = source.pr;
  const items = typeof state === 'string' ? parseItems(info, url) : undefined;
  if (items === undefined)
    return { kind: 'error', reason: 'gh pr view did not name the state of the PR, its reviews and its comments' };

  const ended = state === 'MERGED' || state === 'CLOSED';
  const endedText = `PR ${url} was ${state === 'MERGED' ? 'merged' : 'closed'}.`;
  if (source.seen === undefined) {
    if (ended) return { kind: 'event', text: endedText };
    const there = items.length === 0 ? 'none there yet' : `${items.length} there already`;
    return { kind: 'pending', summary: `waiting for a review or comment, ${there}`, source: remember(source, items) };
  }

  const seen = new Set(source.seen);
  const before = source.seenBefore === undefined ? Number.NEGATIVE_INFINITY : Date.parse(source.seenBefore);
  const fresh = items.filter(({ id, time }) => !seen.has(id) && time >= before);
  const author = loginOf(info['author']);
  const own = new Set([author, source.self].flatMap((login) => (login === undefined ? [] : [sameActor(login)])));
  const others = fresh.filter(({ login }) => login === undefined || !own.has(sameActor(login)));
  if (others.length > 0) return { kind: 'event', text: reviewEventText(url, others) };
  if (ended) return { kind: 'event', text: endedText };
  return {
    kind: 'pending',
    summary: `no new review or comment by someone else, ${items.length} seen`,
    // Everything listed is seen now, the PR author's and this machine's own included: a restart starts from here.
    source: remember(source, items),
  };
}
