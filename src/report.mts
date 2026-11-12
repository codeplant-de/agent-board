import { oneLine } from "./text.mts";
import type { Backend, Task } from "./contract.mts";

export interface ReportDeps {
  backend: Backend;
  print: (line: string) => void;
  notify: (task: Task, text: string) => Promise<void>;
}

// Note, move to Needs me, then tell Slack. A failed Slack post is only a warning.
export async function sendToNeedsMe(deps: ReportDeps, task: Task, text: string): Promise<void> {
  await deps.backend.addNote(task.id, text);
  await deps.backend.updateTask(task.id, { status: "needs-me" });
  await deps.notify(task, oneLine(text, 300)).catch((error: unknown) => {
    deps.print(`WARN notify failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
