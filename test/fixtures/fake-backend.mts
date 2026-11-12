// A test backend that follows the contract (see the README), so the adapter tests run against a faithful one.
// Tasks live in the JSON file named by FAKE_BACKEND_FILE; every call is logged there with its argv and stdin.
// Every call runs under a lock and writes atomically (temp file, then rename), so concurrent calls never lose
// an update. FAKE_BACKEND_MODE makes it misbehave.
import { mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { parseDraft, parsePatch, parseSetupRequest } from "../../src/contract.mts";
import { isRecord } from "../../src/guards.mts";

interface State {
  tasks: Record<string, unknown>[];
  notes: Record<string, unknown>;
  calls: unknown[];
  nextId: number;
  setupDone: boolean;
}

class Failure extends Error {
  code: number;

  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

const file = process.env["FAKE_BACKEND_FILE"] ?? "";
const mode = process.env["FAKE_BACKEND_MODE"] ?? "";
const [command, ...args] = process.argv.slice(2);
const lockDir = `${file}.lock`;

function lock(): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 4000; attempt++) {
    try {
      mkdirSync(lockDir);
      return;
    } catch {
      Atomics.wait(sleeper, 0, 0, 5);
    }
  }
  throw new Failure("could not take the lock");
}

function readState(): State {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw["tasks"]) || !isRecord(raw["notes"]) || !Array.isArray(raw["calls"])) throw new Failure("bad state file");
  const tasks = raw["tasks"].filter(isRecord);
  const nextId = typeof raw["nextId"] === "number" ? raw["nextId"] : tasks.length + 1;
  return { tasks, notes: raw["notes"], calls: raw["calls"], nextId, setupDone: raw["setupDone"] === true };
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Failure("stdin is not valid JSON");
  }
}

async function run(): Promise<void> {
  let stdin = "";
  if (command !== "version" && command !== "list-tasks" && command !== "get-task" && command !== "read-notes") {
    for await (const chunk of process.stdin) stdin += String(chunk);
  }

  if (mode === "hang" && command !== "version") await new Promise((resolve) => setTimeout(resolve, 60_000));
  if (mode === "fail" && command !== "version") throw new Failure("the store is locked\nsecond line", 3);
  if (mode === "noisy-fail" && command !== "version") throw new Failure(`FIRST-LINE-REASON\n${"x".repeat(10_000)}\nLAST-LINE`, 4);
  if (mode === "garbage" && command !== "version") return console.log("this is not json");

  lock();
  try {
    locked(stdin);
  } finally {
    rmdirSync(lockDir);
  }
}

function locked(stdin: string): void {
  const state = readState();
  state.calls.push({ argv: process.argv.slice(2), stdin });
  const print = (value: unknown): void => console.log(JSON.stringify(value));
  const notesOf = (id: string | undefined): unknown[] => {
    const notes = state.notes[id ?? ""];
    return Array.isArray(notes) ? notes : [];
  };
  const find = (id: string | undefined): Record<string, unknown> => {
    const found = state.tasks.find((candidate) => candidate["id"] === id);
    if (!found) throw new Failure(`no task ${id}`);
    return found;
  };

  switch (command) {
    case "version":
      print({ contract: mode === "other-version" ? 2 : 1 });
      break;
    case "list-tasks":
      if (mode === "unsafe-id") state.tasks.push({ id: "../etc", title: "x", input: "", labels: [], status: "todo", url: "u", closed: false });
      if (mode === "missing-field") state.tasks.push({ id: "m1", title: "x" });
      print(state.tasks.filter((task) => args.includes("--all") || task["closed"] !== true));
      break;
    case "get-task":
      print(find(args[0]));
      break;
    case "add-task": {
      const task = { id: `t${state.nextId++}`, url: "https://tasks.example", closed: false, ...parseDraft(json(stdin)) };
      state.tasks.push(task);
      print(task);
      break;
    }
    case "update-task": {
      const patch = parsePatch(json(stdin));
      const task = find(args[0]);
      if (patch.input !== undefined) task["input"] = patch.input;
      if (patch.status !== undefined) {
        // A status change puts the task at the bottom of its new status.
        task["status"] = patch.status;
        state.tasks.splice(state.tasks.indexOf(task), 1);
        state.tasks.push(task);
      }
      print(task);
      break;
    }
    case "add-note":
      find(args[0]);
      if (stdin.trim() === "") throw new Failure("note text on stdin is empty");
      state.notes[args[0] ?? ""] = [...notesOf(args[0]), { text: stdin, createdAt: new Date().toISOString() }];
      break;
    case "read-notes":
      find(args[0]);
      print(notesOf(args[0]));
      break;
    case "setup": {
      if (mode === "no-setup") throw new Failure("unknown command setup", 64);
      parseSetupRequest(json(stdin));
      print({ created: state.setupDone ? [] : ["list Todo"] });
      if (args[0] !== "--dry-run") state.setupDone = true;
      break;
    }
    default:
      throw new Failure(`unknown command ${command}`, 64);
  }
  writeFileSync(`${file}.tmp${process.pid}`, JSON.stringify(state));
  renameSync(`${file}.tmp${process.pid}`, file);
}

// A failing call prints nothing on stdout and leaves the file as it was.
try {
  await run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof Failure ? error.code : 1;
}
