// The core's only way to a task store: one configured CLI, a fixed set of subcommands, JSON on stdout.
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { CONTRACT_VERSION, ContractError, isSafeTaskId, parseNotes, parseSetupResult, parseTask, parseTasks, parseVersion, UNKNOWN_COMMAND_EXIT } from "./contract.mts";
import type { Backend, TaskDraft, TaskPatch } from "./contract.mts";
import { oneLine } from "./text.mts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;

export class BackendError extends Error {
  exitCode: number | undefined;

  constructor(message: string, exitCode?: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

interface Finished {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

function execute(command: string[], args: string[], stdin: string | undefined, timeoutMs: number): Promise<Finished | "timeout"> {
  return new Promise((resolve, reject) => {
    const [file, ...fixed] = command;
    if (file === undefined) return reject(new BackendError("backend command is empty"));
    // No shell: the arguments reach the backend as they are.
    const child = spawn(file, [...fixed, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let tooLarge = false;
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS && !tooLarge) {
        tooLarge = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    // The backend may exit before it has read its stdin.
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new BackendError(`could not start ${basename(file)}: ${error.message}`));
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (tooLarge) return reject(new BackendError(`${basename(file)} printed more than ${MAX_OUTPUT_CHARS} characters`));
      resolve(timedOut ? "timeout" : { exitCode, signal, stdout, stderr });
    });
  });
}

export function createCliBackend(options: { command: string[]; timeoutMs?: number }): Backend {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const name = basename(options.command[0] ?? "backend");

  async function invoke(subcommand: string, args: string[], stdin?: string): Promise<string> {
    const where = `backend ${name} ${subcommand}`;
    const result = await execute(options.command, [subcommand, ...args], stdin, timeoutMs);
    if (result === "timeout") throw new BackendError(`${where} timed out after ${timeoutMs / 1000}s`);
    if (result.exitCode !== 0) {
      const reason = oneLine(result.stderr, 200) || (result.signal ? `killed by ${result.signal}` : "no message");
      throw new BackendError(`${where} failed (exit ${result.exitCode ?? "none"}): ${reason}`, result.exitCode ?? undefined);
    }
    return result.stdout;
  }

  async function invokeJson<T>(subcommand: string, parse: (value: unknown) => T, args: string[] = [], stdin?: string): Promise<T> {
    const stdout = await invoke(subcommand, args, stdin);
    try {
      return parse(JSON.parse(stdout));
    } catch (error) {
      const why = error instanceof ContractError ? error.message : "output is not valid JSON";
      throw new BackendError(`backend ${name} ${subcommand}: ${why}`);
    }
  }

  // Checked once, before the first real call.
  let verified: Promise<void> | undefined;
  const verify = (): Promise<void> => {
    verified ??= invokeJson("version", parseVersion).then((version) => {
      if (version !== CONTRACT_VERSION) throw new BackendError(`backend ${name} speaks contract ${version}, this core needs ${CONTRACT_VERSION}`);
    });
    return verified;
  };

  async function call<T>(subcommand: string, parse: (value: unknown) => T, args: string[] = [], stdin?: string): Promise<T> {
    await verify();
    return invokeJson(subcommand, parse, args, stdin);
  }

  const taskId = (id: string): string => {
    if (!isSafeTaskId(id)) throw new BackendError(`"${id.slice(0, 40)}" is not a valid task id`);
    return id;
  };

  return {
    listTasks: async ({ all = false } = {}) => {
      const tasks = await call("list-tasks", parseTasks, all ? ["--all"] : []);
      return all ? tasks : tasks.filter((task) => !task.closed);
    },
    getTask: async (id) => call("get-task", parseTask, [taskId(id)]),
    addTask: async (draft: TaskDraft) => call("add-task", parseTask, [], JSON.stringify(draft)),
    updateTask: async (id, patch: TaskPatch) => call("update-task", parseTask, [taskId(id)], JSON.stringify(patch)),
    addNote: async (id, text) => {
      const safeId = taskId(id);
      await verify();
      await invoke("add-note", [safeId], text);
    },
    readNotes: async (id) => call("read-notes", parseNotes, [taskId(id)]),
    async setup(labels) {
      await verify();
      try {
        return await invokeJson("setup", parseSetupResult, [], JSON.stringify({ labels }));
      } catch (error) {
        if (error instanceof BackendError && error.exitCode === UNKNOWN_COMMAND_EXIT) return undefined;
        throw error;
      }
    },
  };
}

// Reads go through; every write is printed instead of run.
export function dryRunBackend(inner: Backend, print: (line: string) => void): Backend {
  return {
    ...inner,
    async addTask(draft) {
      print(`DRY add-task ${oneLine(JSON.stringify(draft), 160)}`);
      return { ...draft, id: "dry", url: "dry", closed: false };
    },
    async updateTask(id, patch) {
      print(`DRY update-task ${id} ${oneLine(JSON.stringify(patch), 160)}`);
      return { ...(await inner.getTask(id)), ...patch };
    },
    async addNote(id, text) {
      print(`DRY add-note ${id} ${oneLine(text, 160)}`);
    },
    async setup() {
      print("DRY setup");
      return [];
    },
  };
}
