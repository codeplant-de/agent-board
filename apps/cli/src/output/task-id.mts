// A task id becomes part of paths, unit names, arguments and links, and it may come from the server: every place that
// builds one of those from it refuses anything but the safe shape first.
import { isSafeTaskId } from '@agent-board/shared';

export function requireTaskId(taskId: string, Failure: new (message: string) => Error = Error): void {
  if (!isSafeTaskId(taskId)) throw new Failure(`"${taskId.slice(0, 40)}" is not a task id`);
}
