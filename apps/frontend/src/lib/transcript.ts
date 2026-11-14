import { TRANSCRIPT_PAGE_SIZE } from '@agent-board/shared';

/** `events` plus everything the board has after them, a page at a time; `events` itself when nothing is new. */
export async function loadEventsAfter<T extends { seq: number }>(
  events: T[],
  fetchPage: (afterSeq: number) => Promise<T[]>,
): Promise<T[]> {
  let all = events;
  for (;;) {
    const page = await fetchPage(all.at(-1)?.seq ?? -1);
    if (page.length > 0) all = [...all, ...page];
    if (page.length < TRANSCRIPT_PAGE_SIZE) return all;
  }
}
