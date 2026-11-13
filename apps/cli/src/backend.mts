// The core's only way to a task store: one configured CLI, a fixed set of subcommands, JSON on stdout.
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { CLAIM_LOST_EXIT, CONTRACT_VERSION, ContractError, isSafeMachineName, isSafeTaskId, parseAddTaskResult, parseNotes, parseSetupResult, parseTask, parseTasks, parseVersion, QuestionError, UNKNOWN_COMMAND_EXIT } from "@agent-board/shared";
import type { Backend, Task, TaskDraft, TaskPatch } from "@agent-board/shared";
import { oneLine } from "./text.mts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
// stderr is only shown as a one-line reason, and the reason is the first line.
const STDERR_KEEP_CHARS = 4000;

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

interface ExecuteOptions {
  timeoutMs: number;
  maxOutputChars: number;
}

function execute(command: string[], args: string[], stdin: string | undefined, options: ExecuteOptions): Promise<Finished | "timeout"> {
  return new Promise((resolve, reject) => {
    const [file, ...fixed] = command;
    if (file === undefined) return reject(new BackendError("backend command is empty"));
    // No shell: the arguments reach the backend as they are. Its own process group, so a kill also reaches what it started.
    const child = spawn(file, [...fixed, ...args], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    // Settles once. A killed backend's children may hold the pipes open, so nothing waits for "close" after a kill.
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      child.stdout.destroy();
      child.stderr.destroy();
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > options.maxOutputChars) {
        killGroup();
        settle(() => reject(new BackendError(`${basename(file)} printed more than ${options.maxOutputChars} characters`)));
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < STDERR_KEEP_CHARS) stderr = (stderr + chunk).slice(0, STDERR_KEEP_CHARS);
    });
    // The backend may exit before it has read its stdin.
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
    const timer = setTimeout(() => {
      killGroup();
      settle(() => resolve("timeout"));
    }, options.timeoutMs);
    child.on("error", (error) => {
      settle(() => reject(new BackendError(`could not start ${basename(file)}: ${error.message}`)));
    });
    child.on("close", (exitCode, signal) => {
      settle(() => resolve({ exitCode, signal, stdout, stderr }));
    });
  });
}

export function createCliBackend(options: { command: string[]; timeoutMs?: number; maxOutputChars?: number }): Backend {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const name = basename(options.command[0] ?? "backend");

  async function invoke(subcommand: string, args: string[], stdin?: string): Promise<string> {
    const where = `backend ${name} ${subcommand}`;
    const result = await execute(options.command, [subcommand, ...args], stdin, { timeoutMs, maxOutputChars });
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
      const why = error instanceof ContractError || error instanceof QuestionError ? error.message : "output is not valid JSON";
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
    addTask: async (draft: TaskDraft) => call("add-task", parseAddTaskResult, [], JSON.stringify(draft)),
    updateTask: async (id, patch: TaskPatch) => call("update-task", parseTask, [taskId(id)], JSON.stringify(patch)),
    async claimTask(id, machine) {
      if (!isSafeMachineName(machine)) throw new BackendError(`"${machine.slice(0, 40)}" is not a valid machine name`);
      try {
        return await call("claim-task", parseTask, [taskId(id), "--machine", machine]);
      } catch (error) {
        if (error instanceof BackendError && error.exitCode === CLAIM_LOST_EXIT) return undefined;
        throw error;
      }
    },
    addNote: async (id, text, { author = "agent" } = {}) => {
      const safeId = taskId(id);
      await verify();
      await invoke("add-note", author === "agent" ? [safeId] : [safeId, "--author", author], text);
    },
    ask: async (id, questions) => {
      const safeId = taskId(id);
      await verify();
      await invoke("ask", [safeId], JSON.stringify({ questions }));
    },
    heartbeat: async (id, beat) => {
      const safeId = taskId(id);
      await verify();
      await invoke("heartbeat", [safeId], JSON.stringify(beat));
    },
    pause: async (id, note) => call("pause", parseTask, [taskId(id)], note),
    readNotes: async (id) => call("read-notes", parseNotes, [taskId(id)]),
    async setup(labels, { dryRun = false } = {}) {
      await verify();
      try {
        return await invokeJson("setup", parseSetupResult, dryRun ? ["--dry-run"] : [], JSON.stringify({ labels }));
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
      const { dedupeKey: _key, parentId: _parent, createdBy, machine, workdir, ...fields } = draft;
      const task: Task = { ...fields, priority: draft.priority ?? "normal", id: "dry", url: "https://dry.invalid", closed: false, machine: machine ?? null, sessionId: null, workdir: workdir ?? null, next: "fresh", openQuestion: false, createdBy: createdBy ?? "user", lane: null, borrowed: false, lastActiveAt: null };
      return { task, created: true };
    },
    async updateTask(id, patch) {
      print(`DRY update-task ${id} ${oneLine(JSON.stringify(patch), 160)}`);
      return { ...(await inner.getTask(id)), ...patch };
    },
    async claimTask(id, machine) {
      print(`DRY claim-task ${id} --machine ${machine}`);
      const task = await inner.getTask(id);
      return { ...task, status: "running", machine };
    },
    async addNote(id, text, options) {
      print(`DRY add-note ${id}${options?.author === "system" ? " --author system" : ""} ${oneLine(text, 160)}`);
    },
    async heartbeat(id, beat) {
      print(`DRY heartbeat ${id} ${JSON.stringify(beat)}`);
    },
    async pause(id, note) {
      print(`DRY pause ${id} ${oneLine(note, 160)}`);
      return { ...(await inner.getTask(id)), status: "todo", next: "resume" };
    },
    async ask(id, questions) {
      print(`DRY ask ${id} ${oneLine(JSON.stringify(questions), 160)}`);
    },
    async setup(labels) {
      const planned = await inner.setup(labels, { dryRun: true });
      for (const what of planned ?? []) print(`DRY create ${what}`);
      return planned === undefined ? undefined : [];
    },
  };
}
