import { STATUSES } from '@agent-board/shared';

export const TASKS = 'Tasks:';
export const SCHEDULING = 'Scheduling:';
export const SETUP = 'Setup:';

export const STATUS_LIST = STATUSES.join(', ');
export const TASK_ARGUMENT = 'the task: its id, a board task link or the start of its id';
export const ID_NOTE =
  '<task> can be the full id, a link to the task on this board (as the CLI prints it: `<web.json url>/t/<id>`), or the start of the id (3 to 11 characters, but not exactly 8, which counts as a whole older id; an exact-case match wins, else case does not matter; it must be unique). Inside a board run only the full id is accepted.';

export function paragraphs(...text: string[]): string {
  return text.join('\n\n');
}

export function examples(...lines: string[]): string {
  return `\nExamples:\n${lines.map((line) => `  ${line}`).join('\n')}\n`;
}
