// The pr-merged source (`--pr-merged`): whether a PR was merged or closed, read with `gh pr view`. What to make of what gh said is a
// pure function. The dispatcher's PR state lookup (dispatch/github.mts) asks GitHub for many PRs at once and learns the state
// alone; a watch asks for one PR, in the run's directory and with its settings, and wants the merge commit too. Both read the
// state through `prStateOf`.
import { isRecord } from '@agent-board/shared';
import { prStateOf } from '../dispatch/github.mts';
import { shellQuote } from '../output/text.mts';
import { firstLine } from './ci.mts';
import type { GhOutput } from './ci.mts';
import type { WatchSource } from './store.mts';

export type MergedSource = Extract<WatchSource, { kind: 'pr-merged' }>;

export type MergedDecision =
  // The watch ends with this text.
  | { kind: 'event'; text: string }
  | { kind: 'pending'; summary: string }
  // gh could not tell (auth, an unknown PR, the network).
  | { kind: 'error'; reason: string };

export const mergedViewCommand = (pr: string): string =>
  `gh pr view ${shellQuote(pr)} --json state,mergedAt,closedAt,mergeCommit`;

const COMMIT = /^[0-9a-f]{40}$/;

const isTime = (value: unknown): boolean => typeof value === 'string' && !Number.isNaN(Date.parse(value));

/**
 * What `gh pr view` says of the PR. Merged ends the watch with the merge commit, closed ends it as closed without merging, open
 * keeps it pending. A time in `mergedAt` or `closedAt` counts like the state, so a state this CLI does not know still ends the
 * watch. The URL in the text is the one the watch was registered with, already shape-checked.
 */
export function decideMerged(source: MergedSource, view: GhOutput): MergedDecision {
  if (view.exitCode !== 0) return { kind: 'error', reason: firstLine(view.stderr, 'gh pr view failed') };
  let info: unknown;
  try {
    info = JSON.parse(view.stdout);
  } catch {
    return { kind: 'error', reason: 'gh pr view printed something that is not JSON' };
  }
  if (!isRecord(info)) return { kind: 'error', reason: 'gh pr view printed something unexpected' };
  const state = prStateOf(info['state']);
  if (state === 'merged' || isTime(info['mergedAt'])) {
    const commit = isRecord(info['mergeCommit']) ? info['mergeCommit']['oid'] : undefined;
    const as = typeof commit === 'string' && COMMIT.test(commit) ? ` as ${commit.slice(0, 7)}` : '';
    return { kind: 'event', text: `PR ${source.pr} was merged${as}.` };
  }
  if (state === 'closed' || isTime(info['closedAt']))
    return { kind: 'event', text: `PR ${source.pr} was closed without merging.` };
  if (state === 'open') return { kind: 'pending', summary: 'still open' };
  return { kind: 'error', reason: 'gh pr view did not name the state of the PR' };
}
