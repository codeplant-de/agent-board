import { UNREADABLE_TEXT } from '@agent-board/shared';
import type { Note } from '@agent-board/shared';
import { taskJson } from '../commands/board.mts';
import { oneLine } from '../output/text.mts';
import { plainLine } from '../output/terminal.mts';
import type { Style } from '../output/style.mts';
import { EVENT_TYPES } from './diff.mts';
import type { BoardEvent } from './diff.mts';

const ID_WIDTH = 12;
const TYPE_WIDTH = Math.max(...EVENT_TYPES.map((type) => type.length));
const TITLE_WIDTH = 80;
const NOTE_WIDTH = 100;

const clock = (at: Date): string => at.toTimeString().slice(0, 8);

// What the note says on one line: its first line that has text, cut.
function noteLine(note: Note): string {
  if (note.unreadable) return UNREADABLE_TEXT;
  const first = note.text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  return plainLine(oneLine(first, NOTE_WIDTH));
}

function detail(event: BoardEvent): string {
  switch (event.type) {
    case 'created':
      return event.task.status;
    case 'moved':
      return `${event.from} → ${event.to}${event.actor === undefined ? '' : ` by ${event.actor}`}`;
    case 'changed':
      return (event.fields ?? []).join(', ');
    case 'closed':
      return 'closed';
    case 'removed':
      return 'deleted';
    case 'note':
      return event.note === undefined ? '' : `${plainLine(event.note.author)} ${plainLine(event.note.kind)}`;
  }
}

/** One line for a person: `14:02:11  moved    Ab3dEf9x     todo → needs-me  <title>`. Everything from the board has its control characters replaced. */
export function eventLine(event: BoardEvent, style: Style): string {
  const title = plainLine(oneLine(event.task.title, TITLE_WIDTH));
  const said = event.note === undefined ? '' : `  ${style.dim(`"${noteLine(event.note)}"`)}`;
  return `${style.dim(clock(event.at))}  ${style.bold(event.type.padEnd(TYPE_WIDTH))}  ${plainLine(event.task.id).padEnd(ID_WIDTH)}  ${detail(event)}  ${title}${said}`;
}

/** One object per event, for scripts: the task as `board tasks --json` shows it, plus its link. */
export function eventJson(event: BoardEvent, taskLink: (id: string) => string): Record<string, unknown> {
  const { note } = event;
  return {
    type: event.type,
    at: event.at.toISOString(),
    task: { ...taskJson(event.task), url: taskLink(event.task.id) },
    ...(event.from === undefined ? {} : { from: event.from }),
    ...(event.to === undefined ? {} : { to: event.to }),
    ...(event.actor === undefined ? {} : { actor: event.actor }),
    ...(event.fields === undefined ? {} : { fields: event.fields }),
    ...(note === undefined
      ? {}
      : {
          note: {
            id: note.id,
            author: note.author,
            kind: note.kind,
            text: note.unreadable ? null : note.text,
            createdAt: note.createdAt.toISOString(),
            unreadable: note.unreadable,
          },
        }),
  };
}
