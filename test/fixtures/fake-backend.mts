// A minimal backend for the adapter tests. Tasks live in the JSON file named by FAKE_BACKEND_FILE;
// every call is logged there with its argv and stdin. FAKE_BACKEND_MODE makes it misbehave.
import { readFileSync, writeFileSync } from "node:fs";
import { isRecord } from "../../src/guards.mts";

interface State {
  tasks: Record<string, unknown>[];
  notes: Record<string, { text: string; createdAt: string }[]>;
  calls: { argv: string[]; stdin: string }[];
}

const file = process.env["FAKE_BACKEND_FILE"] ?? "";
const mode = process.env["FAKE_BACKEND_MODE"] ?? "";
const [command, ...args] = process.argv.slice(2);

function readState(): State {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw["tasks"]) || !isRecord(raw["notes"]) || !Array.isArray(raw["calls"])) throw new Error("bad state file");
  return { tasks: raw["tasks"].filter(isRecord), notes: {}, calls: [], ...raw };
}

let stdin = "";
if (command !== "version" && command !== "list-tasks" && command !== "get-task" && command !== "read-notes") {
  for await (const chunk of process.stdin) stdin += String(chunk);
}

const state = readState();
state.calls.push({ argv: process.argv.slice(2), stdin });
const save = (): void => writeFileSync(file, JSON.stringify(state));
const print = (value: unknown): void => console.log(JSON.stringify(value));
const find = (id: string | undefined): Record<string, unknown> => {
  const found = state.tasks.find((candidate) => candidate["id"] === id);
  if (!found) {
    console.error(`no task ${id}`);
    process.exit(1);
  }
  return found;
};

if (mode === "hang" && command !== "version") await new Promise((resolve) => setTimeout(resolve, 60_000));
if (mode === "fail" && command !== "version") {
  console.error("the store is locked\nsecond line");
  process.exit(3);
}
if (mode === "garbage" && command !== "version") {
  console.log("this is not json");
  process.exit(0);
}

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
    const draft: unknown = JSON.parse(stdin);
    if (!isRecord(draft)) process.exit(1);
    const task = { id: `t${state.tasks.length + 1}`, url: "https://tasks.example", closed: false, ...draft };
    state.tasks.push(task);
    save();
    print(task);
    break;
  }
  case "update-task": {
    const task = find(args[0]);
    Object.assign(task, JSON.parse(stdin));
    save();
    print(task);
    break;
  }
  case "add-note":
    find(args[0]);
    (state.notes[args[0] ?? ""] ??= []).push({ text: stdin, createdAt: "2026-01-01T00:00:00.000Z" });
    save();
    break;
  case "read-notes":
    find(args[0]);
    print(state.notes[args[0] ?? ""] ?? []);
    break;
  case "setup":
    if (mode === "no-setup") {
      console.error("unknown command setup");
      process.exit(64);
    }
    print({ created: ["list Todo"] });
    break;
  default:
    console.error(`unknown command ${command}`);
    process.exit(64);
}
save();
