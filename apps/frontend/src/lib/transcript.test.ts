import { TRANSCRIPT_PAGE_SIZE } from '@agent-board/shared';
import { describe, expect, it } from 'vitest';
import { loadEventsAfter } from './transcript';

const events = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ seq: from + i }));

/** A board holding `total` events, serving pages after a seq. */
function board(total: number) {
  const afterSeqs: number[] = [];
  const fetchPage = async (afterSeq: number) => {
    afterSeqs.push(afterSeq);
    return events(afterSeq + 1, Math.max(0, Math.min(TRANSCRIPT_PAGE_SIZE, total - (afterSeq + 1))));
  };
  return { afterSeqs, fetchPage };
}

describe('loadEventsAfter', () => {
  it('pages through a long run until a page comes back short', async () => {
    const { afterSeqs, fetchPage } = board(2 * TRANSCRIPT_PAGE_SIZE + 5);
    const loaded = await loadEventsAfter([], fetchPage);
    expect(loaded).toHaveLength(2 * TRANSCRIPT_PAGE_SIZE + 5);
    expect(loaded.map((e) => e.seq)).toEqual(loaded.map((_, i) => i));
    expect(afterSeqs).toEqual([-1, TRANSCRIPT_PAGE_SIZE - 1, 2 * TRANSCRIPT_PAGE_SIZE - 1]);
  });

  it('asks only for what follows the last event it has, and returns the same list when nothing is new', async () => {
    const have = events(0, 10);
    const { afterSeqs, fetchPage } = board(10);
    expect(await loadEventsAfter(have, fetchPage)).toBe(have);
    expect(afterSeqs).toEqual([9]);
    const more = board(13);
    expect((await loadEventsAfter(have, more.fetchPage)).map((e) => e.seq)).toEqual(
      Array.from({ length: 13 }, (_, i) => i),
    );
  });

  it('takes one more request when the last page is exactly full', async () => {
    const { afterSeqs, fetchPage } = board(TRANSCRIPT_PAGE_SIZE);
    expect(await loadEventsAfter([], fetchPage)).toHaveLength(TRANSCRIPT_PAGE_SIZE);
    expect(afterSeqs).toEqual([-1, TRANSCRIPT_PAGE_SIZE - 1]);
  });
});
