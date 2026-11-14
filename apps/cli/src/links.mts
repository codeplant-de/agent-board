// A link to a task on the board. The CLI builds every one itself, from the board URL in its own web.json and the task id: the
// board server also sends a link per task, but it is server text, so nothing here (a printed line, a Slack message) uses it.
import { isSafeTaskId } from '@agent-board/shared';

export function taskLink(boardUrl: string, taskId: string): string {
  if (!isSafeTaskId(taskId)) throw new Error(`"${taskId.slice(0, 40)}" is not a task id`);
  return `${boardUrl}/t/${taskId}`;
}
