import { isWatchName, type TaskWatch } from '@agent-board/shared';
import type { BoardTask } from './trpc';

/** The start of every thread note a watch event leaves; the CLI writes it, the thread draws it as a compact row. */
export const WATCH_MARKER = 'agent-board: watch';

/** A CI status such as "4 of 7 passed, 3 running" as "4/7"; undefined for any other status. */
export function shortWatchStatus(watch: Pick<TaskWatch, 'kind' | 'status'>): string | undefined {
  if (watch.kind !== 'ci') return undefined;
  const match = /^(\d+) of (\d+) passed/.exec(watch.status);
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

/** What a card says of a task's watches ("Watching CI #116 · 4/7", "+1" for more); undefined when none are shown. */
export function watchBadgeText(task: Pick<BoardTask, 'status' | 'watches'>): string | undefined {
  const [first, ...more] = task.watches ?? [];
  if (first === undefined || (task.status !== 'running' && task.status !== 'waiting')) return undefined;
  const short = shortWatchStatus(first);
  const text = `Watching ${first.label}${short === undefined ? '' : ` · ${short}`}`;
  return more.length === 0 ? text : `${text} +${more.length}`;
}

/** The note of a watch event: an agent comment with no suggestion that starts with the marker. */
export const isWatchNote = ({
  author,
  kind,
  text,
  suggestion,
}: {
  author: string;
  kind: string;
  text: string;
  suggestion?: string | undefined;
}): boolean => author === 'agent' && kind === 'comment' && suggestion === undefined && text.startsWith(WATCH_MARKER);

/** The title of a watch note, `Watch "ci" reported`, and its body (the fenced text); a first line of another shape gets a plain title. */
export function splitWatchNote(text: string): { title: string; body: string } {
  const [first = '', ...rest] = text.split('\n');
  const name = /^agent-board: watch "([^"]*)" reported\.$/.exec(first.trim())?.[1];
  const title = name !== undefined && isWatchName(name) ? `Watch "${name}" reported` : 'Watch reported';
  return { title, body: rest.join('\n').trim() };
}
