// A link to a task on the board. The CLI builds every one itself, from the board URL in its own web.json and the task id: the
// board sends no link, so nothing here (a printed line) carries text of the server's.
import { requireTaskId } from './task-id.mts';

export function taskLink(boardUrl: string, taskId: string): string {
  requireTaskId(taskId);
  return `${boardUrl}/t/${taskId}`;
}
