import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unitName } from "./decide.mts";

const run = promisify(execFile);

export interface System {
  isActive(unit: string): Promise<boolean>;
  stop(unit: string): Promise<void>;
  startWorker(shortLink: string): Promise<{ pid: number | undefined }>;
}

export function createSystem(input: { workerScript: string; dryRun: boolean; print: (line: string) => void }): System {
  return {
    async isActive(unit) {
      try {
        const { stdout } = await run("systemctl", ["--user", "is-active", unit]);
        return stdout.trim() === "active";
      } catch {
        return false;
      }
    },
    async stop(unit) {
      if (input.dryRun) return input.print(`DRY systemctl --user stop ${unit}`);
      await run("systemctl", ["--user", "stop", unit]).catch(() => undefined);
    },
    async startWorker(shortLink) {
      const unit = unitName(shortLink);
      // A transient unit does not inherit this environment, so pass on what the worker needs.
      const args = ["--user", "--quiet", "--collect", `--unit=${unit}`, "--setenv=PATH", "--setenv=HOME"];
      for (const name of ["AGENT_BOARD_CONFIG_DIR", "AGENT_BOARD_STATE_DIR", "XDG_STATE_HOME"]) {
        if (process.env[name]) args.push(`--setenv=${name}`);
      }
      args.push("--", process.execPath, input.workerScript, shortLink);
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
