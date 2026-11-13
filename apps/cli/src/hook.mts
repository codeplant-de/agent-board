#!/usr/bin/env node
/**
 * The PreToolUse hook of every skill run: `agent-hook <run dir> <task>`, with the hook input on stdin.
 * It touches the task's heartbeat, records the agent's working directory (a worktree it entered shows up here), and while a pause is requested it refuses every tool call but `board comment`,
 * telling the agent to post a status and end its turn. It never fails the tool call for its own errors: a broken
 * hook must not break a run.
 */
import { isSafeTaskId } from "@agent-board/shared";
import { isRecord } from "@agent-board/shared";
import { createRunFiles } from "./runtime.mts";

export const PAUSE_REASON =
  "Pause requested: this machine needs the slot for other work. Post a one-line status of where you are with `board comment <task> \"...\"`, then end your turn without any other tool call. You will be resumed later in this same session.";

// The only call let through during a pause: the status note the reason asks for. Anything chained to it is still
// checked part by part by Claude Code's own permission rules, so the text after `board comment` is not inspected
// (a status note may well contain a `;`).
export function allowedDuringPause(input: unknown): boolean {
  if (!isRecord(input) || input["tool_name"] !== "Bash") return false;
  const toolInput = input["tool_input"];
  const command = isRecord(toolInput) ? toolInput["command"] : undefined;
  return typeof command === "string" && /^board comment \S+ /.test(command.trim());
}

// What the hook prints: nothing to let the call run, or a deny decision.
export function hookDecision(input: unknown, pauseRequested: boolean, taskId: string): string {
  if (!pauseRequested || allowedDuringPause(input)) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: PAUSE_REASON.replace("<task>", taskId),
    },
  });
}

async function readStdin(): Promise<string> {
  let content = "";
  for await (const chunk of process.stdin) content += String(chunk);
  return content;
}

if (import.meta.main) {
  const [dir, taskId] = process.argv.slice(2);
  try {
    if (!dir || !taskId || !isSafeTaskId(taskId)) throw new Error("usage: agent-hook <run dir> <task>");
    const files = createRunFiles(dir);
    files.touchAlive(taskId);
    let input: unknown;
    try {
      input = JSON.parse(await readStdin());
    } catch {
      input = undefined;
    }
    if (isRecord(input) && typeof input["cwd"] === "string" && input["cwd"].startsWith("/")) files.writeCwd(taskId, input["cwd"]);
    const decision = hookDecision(input, files.pauseRequestedAt(taskId) !== undefined, taskId);
    if (decision) process.stdout.write(decision);
  } catch (error) {
    // stderr of a hook that exits 0 only shows in verbose mode; the call goes ahead.
    console.error(`agent-hook: ${error instanceof Error ? error.message : String(error)}`);
  }
}
