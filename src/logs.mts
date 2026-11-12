import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPaths } from "./config.mts";
import { tail } from "./text.mts";

const TAIL_CHARS = 4000;

export function logPath(shortLink: string): string {
  return join(getPaths().logDir, `${shortLink}.log`);
}

// One log per card; a new run replaces the previous one. Logs can hold review findings, so owner-only.
export function openLog(shortLink: string): number {
  const { logDir } = getPaths();
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  return openSync(logPath(shortLink), "w", 0o600);
}

export function closeLog(fd: number): void {
  closeSync(fd);
}

export function readLogTail(shortLink: string): string {
  try {
    return tail(readFileSync(logPath(shortLink), "utf8").trim(), TAIL_CHARS);
  } catch {
    return "";
  }
}
