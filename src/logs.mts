import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPaths } from "./config.mts";
import { tail } from "./text.mts";

const TAIL_CHARS = 4000;

export function logPath(taskId: string): string {
  return join(getPaths().logDir, `${taskId}.log`);
}

// One log per task; a new run replaces the previous one. Logs can hold review findings, so owner-only.
export function openLog(taskId: string): number {
  const { logDir } = getPaths();
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  return openSync(logPath(taskId), "w", 0o600);
}

// First thing a worker does, so the sweep never shows the log of an earlier run.
export function resetLog(taskId: string): void {
  closeSync(openLog(taskId));
}

export function appendLog(taskId: string, text: string): void {
  try {
    appendFileSync(logPath(taskId), `\n${text}\n`, { mode: 0o600 });
  } catch {
    // The log is a courtesy; the task note still carries the reason.
  }
}

export function closeLog(fd: number): void {
  closeSync(fd);
}

export function readLogTail(taskId: string): string {
  try {
    return tail(readFileSync(logPath(taskId), "utf8").trim(), TAIL_CHARS);
  } catch {
    return "";
  }
}
