import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unitName } from "./decide.mts";

const run = promisify(execFile);

export class SystemError extends Error {}

export interface System {
  isActive(unit: string): Promise<boolean>;
  // When the unit last became active; undefined if it is not loaded.
  startedAt(unit: string): Promise<Date | undefined>;
  // Task ids of the worker units that are running now.
  activeWorkers(): Promise<string[]>;
  stop(unit: string): Promise<void>;
  startWorker(taskId: string): Promise<{ pid: number | undefined }>;
}

const LIVE_STATES = ["active", "activating", "reloading", "deactivating", "refreshing"];
const GONE_STATES = ["inactive", "failed"];

// Only a state systemd names counts as an answer. A broken bus or a missing binary prints nothing known,
// and must not read as "the unit is gone".
export function parseUnitState(stdout: string): boolean {
  const state = stdout.trim();
  if (LIVE_STATES.includes(state)) return true;
  if (GONE_STATES.includes(state)) return false;
  throw new SystemError(`systemctl gave no known unit state (got "${state.slice(0, 40)}")`);
}

const NON_WORKER_UNITS = ["agent-board-dispatch", "agent-board-intake"];

export function parseWorkerUnits(stdout: string): string[] {
  const taskIds: string[] = [];
  for (const line of stdout.split("\n")) {
    const name = /^\s*[●*]?\s*(agent-board-[^\s.]+)\.service\s/.exec(line)?.[1];
    if (name === undefined || NON_WORKER_UNITS.includes(name)) continue;
    taskIds.push(name.slice("agent-board-".length));
  }
  return taskIds;
}

// `systemctl --timestamp=unix` prints "@<seconds>", or an empty value for a unit that never started.
export function parseUnixTimestamp(stdout: string): Date | undefined {
  const seconds = /^@(\d+)$/.exec(stdout.trim())?.[1];
  if (seconds === undefined || Number(seconds) === 0) return undefined;
  return new Date(Number(seconds) * 1000);
}

async function systemctl(args: string[]): Promise<string> {
  try {
    return (await run("systemctl", ["--user", ...args])).stdout;
  } catch (error) {
    // is-active exits non-zero for a unit that is not running but still prints its state.
    if (typeof error === "object" && error !== null && "stdout" in error && typeof error.stdout === "string" && error.stdout.trim() !== "") {
      return error.stdout;
    }
    throw new SystemError(`systemctl --user ${args[0]} failed: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`);
  }
}

export function createSystem(input: { workerScript: string; dryRun: boolean; print: (line: string) => void }): System {
  return {
    async isActive(unit) {
      return parseUnitState(await systemctl(["is-active", unit]));
    },
    async startedAt(unit) {
      return parseUnixTimestamp(await systemctl(["--timestamp=unix", "show", "--property=ActiveEnterTimestamp", "--value", unit]));
    },
    async activeWorkers() {
      return parseWorkerUnits(await systemctl(["list-units", "agent-board-*", "--type=service", "--state=active,activating,reloading,deactivating", "--plain", "--no-legend", "--no-pager"]));
    },
    async stop(unit) {
      if (input.dryRun) return input.print(`DRY systemctl --user stop ${unit}`);
      await run("systemctl", ["--user", "stop", unit]).catch(() => undefined);
    },
    async startWorker(taskId) {
      const unit = unitName(taskId);
      // A transient unit does not inherit this environment, so pass on what the worker needs.
      const args = ["--user", "--quiet", "--collect", `--unit=${unit}`, "--setenv=PATH", "--setenv=HOME"];
      for (const name of ["AGENT_BOARD_CONFIG_DIR", "AGENT_BOARD_STATE_DIR", "XDG_STATE_HOME"]) {
        if (process.env[name]) args.push(`--setenv=${name}`);
      }
      args.push("--", process.execPath, input.workerScript, taskId);
      if (input.dryRun) {
        input.print(`DRY systemd-run ${args.join(" ")}`);
        return { pid: undefined };
      }
      await run("systemd-run", args);
      const { stdout } = await run("systemctl", ["--user", "show", "--property=MainPID", "--value", unit]).catch(() => ({
        stdout: "",
      }));
      const pid = Number(stdout.trim());
      return { pid: pid > 0 ? pid : undefined };
    },
  };
}
