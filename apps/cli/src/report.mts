import { oneLine } from './text.mts';
import type { Backend, Task } from '@agent-board/shared';

export interface ReportDeps {
  backend: Backend;
  print: (line: string) => void;
  notify: (task: Task, text: string) => Promise<void>;
}

// Moves a running task to Needs me with the text in its thread, then tells Slack. Nothing happens when the task is no
// longer running. A failed Slack post is only a warning.
export async function sendToNeedsMe(deps: ReportDeps, task: Task, text: string): Promise<void> {
  const { applied } = await deps.backend.fail(task.id, text);
  if (!applied) return;
  await deps.notify(task, oneLine(text, 300)).catch((error: unknown) => {
    deps.print(`WARN notify failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
