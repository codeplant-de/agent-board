import type { PrState } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { canMoveMergedToDone } from './mergedPrs';

const pr = (n: number, state: PrState | null) => ({ id: `r${n}`, url: `https://github.com/acme/app/pull/${n}`, state });
const task = (
  overrides: Partial<Parameters<typeof canMoveMergedToDone>[0]> = {},
): Parameters<typeof canMoveMergedToDone>[0] => ({
  input: 'fix it',
  prs: [],
  promptPrState: null,
  proposed: false,
  openQuestion: false,
  ...overrides,
});

describe('a task that can move to Done', () => {
  it('has a merged reported PR', () => {
    expect(canMoveMergedToDone(task({ prs: [pr(1, 'merged')] }))).toBe(true);
  });

  it('has a merged PR in its prompt', () => {
    expect(
      canMoveMergedToDone(task({ input: '/review-pr https://github.com/acme/app/pull/9', promptPrState: 'merged' })),
    ).toBe(true);
  });

  it('has merged and closed PRs only, at least one merged', () => {
    expect(canMoveMergedToDone(task({ prs: [pr(1, 'merged'), pr(2, 'closed')] }))).toBe(true);
    expect(canMoveMergedToDone(task({ prs: [pr(1, 'closed'), pr(2, 'closed')] }))).toBe(false);
  });

  it('waits for a PR that is still open or unknown', () => {
    expect(canMoveMergedToDone(task({ prs: [pr(1, 'merged'), pr(2, 'open')] }))).toBe(false);
    expect(canMoveMergedToDone(task({ prs: [pr(1, 'merged'), pr(2, null)] }))).toBe(false);
    expect(
      canMoveMergedToDone(task({ input: '/review-pr https://github.com/acme/app/pull/9', prs: [pr(1, 'merged')] })),
    ).toBe(false);
  });

  it('counts a PR of the prompt that was also reported once, by the reported state', () => {
    const input = '/review-pr https://github.com/acme/app/pull/1';
    expect(canMoveMergedToDone(task({ input, prs: [pr(1, 'merged')] }))).toBe(true);
  });

  it('has no PR, no', () => {
    expect(canMoveMergedToDone(task())).toBe(false);
  });

  it('asks nothing and is the user’s', () => {
    expect(canMoveMergedToDone(task({ prs: [pr(1, 'merged')], proposed: true }))).toBe(false);
    expect(canMoveMergedToDone(task({ prs: [pr(1, 'merged')], openQuestion: true }))).toBe(false);
  });
});
