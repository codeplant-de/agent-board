import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BackendError, createCliBackend, dryRunBackend } from "../src/backend.mts";
import type { Backend } from "../src/contract.mts";
import { fakeBackend, task } from "./helpers.mts";

const FIXTURE = new URL("./fixtures/fake-backend.mts", import.meta.url).pathname;

function setup(mode = "", timeoutMs?: number): { backend: Backend; stateFile: string } {
  const stateFile = join(mkdtempSync(join(tmpdir(), "agent-board-backend-")), "state.json");
  writeFileSync(stateFile, JSON.stringify({ tasks: [], notes: {}, calls: [] }));
  process.env["FAKE_BACKEND_FILE"] = stateFile;
  process.env["FAKE_BACKEND_MODE"] = mode;
  return { backend: createCliBackend({ command: [process.execPath, FIXTURE], timeoutMs }), stateFile };
}

function calls(stateFile: string): { argv: string[]; stdin: string }[] {
  const raw: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
  return typeof raw === "object" && raw !== null && "calls" in raw && Array.isArray(raw.calls) ? raw.calls : [];
}

test("all operations round trip through the CLI", async () => {
  const { backend } = setup();
  const created = await backend.addTask({ title: "PR 1", input: "https://x/1\nhead: abc1234", labels: ["review-pr"], status: "todo" });
  assert.equal(created.status, "todo");
  assert.deepEqual((await backend.listTasks()).map((t) => t.id), [created.id]);
  assert.equal((await backend.getTask(created.id)).input, "https://x/1\nhead: abc1234");
  const updated = await backend.updateTask(created.id, { status: "running" });
  assert.equal(updated.status, "running");
  await backend.addNote(created.id, "first");
  await backend.addNote(created.id, "second");
  const notes = await backend.readNotes(created.id);
  assert.deepEqual(notes.map((n) => n.text), ["first", "second"]);
  assert.ok(notes[0]?.createdAt instanceof Date);
  assert.deepEqual(await backend.setup(["review-pr"]), ["list Todo"]);
});

test("closed tasks only come with all", async () => {
  const { backend, stateFile } = setup();
  const created = await backend.addTask({ title: "t", input: "", labels: [], status: "done" });
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.tasks[0].closed = true;
  writeFileSync(stateFile, JSON.stringify(state));
  assert.deepEqual(await backend.listTasks(), []);
  assert.deepEqual((await backend.listTasks({ all: true })).map((t) => t.id), [created.id]);
});

test("free text travels on stdin, never in argv", async () => {
  const { backend, stateFile } = setup();
  const { id } = await backend.addTask({ title: "SECRET-TITLE", input: "SECRET-INPUT", labels: [], status: "todo" });
  await backend.addNote(id, "multi\nline $(rm -rf /) note");
  await backend.updateTask(id, { input: "NEW-INPUT" });
  const writes = calls(stateFile).filter((call) => ["add-task", "add-note", "update-task"].includes(call.argv[0] ?? ""));
  assert.equal(writes.length, 3);
  for (const call of writes) assert.ok(!call.argv.join(" ").match(/SECRET|NEW-INPUT|multi|rm -rf/), call.argv.join(" "));
  assert.equal(writes[1]?.stdin, "multi\nline $(rm -rf /) note");
  assert.deepEqual(JSON.parse(writes[2]?.stdin ?? ""), { input: "NEW-INPUT" });
});

test("the contract version is checked once, before the first call", async () => {
  const { backend, stateFile } = setup();
  await backend.listTasks();
  await backend.listTasks();
  assert.deepEqual(calls(stateFile).map((call) => call.argv[0]), ["version", "list-tasks", "list-tasks"]);
  const other = setup("other-version");
  await assert.rejects(other.backend.listTasks(), /speaks contract 2, this core needs 1/);
});

test("a non-zero exit is a one-line failure with the backend's reason", async () => {
  const { backend } = setup("fail");
  await assert.rejects(backend.listTasks(), (error: Error) => error instanceof BackendError && /failed \(exit 3\): the store is locked second line/.test(error.message) && !error.message.includes("\n"));
});

test("invalid JSON and a missing field are backend failures", async () => {
  await assert.rejects(setup("garbage").backend.listTasks(), /list-tasks: output is not valid JSON/);
  await assert.rejects(setup("missing-field").backend.listTasks(), /task\.\w+ must be/);
});

test("a backend that hangs is killed at the timeout", async () => {
  const started = Date.now();
  await assert.rejects(setup("hang", 400).backend.listTasks(), /timed out after 0.4s/);
  assert.ok(Date.now() - started < 5_000);
});

test("a backend that cannot start is a failure", async () => {
  const backend = createCliBackend({ command: ["no-such-backend-xyz"] });
  await assert.rejects(backend.listTasks(), /could not start no-such-backend-xyz/);
});

test("an unsafe task id is rejected, whether the backend returns it or the caller passes it", async () => {
  await assert.rejects(setup("unsafe-id").backend.listTasks(), /task id "..\/etc" is not safe/);
  const { backend, stateFile } = setup();
  for (const id of ["../x", "-flag", "a b", "", "x".repeat(65), "a;b"]) {
    await assert.rejects(backend.getTask(id), /not a valid task id/);
    await assert.rejects(backend.addNote(id, "x"), BackendError);
  }
  assert.deepEqual(calls(stateFile), [], "nothing reached the backend");
});

test("a backend without setup is reported as undefined, not an error", async () => {
  assert.equal(await setup("no-setup").backend.setup([]), undefined);
});

test("dry run reads through and prints every write instead of making it", async () => {
  const inner = fakeBackend([task({ id: "a" })]);
  const printed: string[] = [];
  const dry = dryRunBackend(inner, (line) => printed.push(line));
  assert.equal((await dry.getTask("a")).id, "a");
  assert.equal((await dry.updateTask("a", { status: "running" })).status, "running");
  await dry.addNote("a", "hello");
  const created = await dry.addTask({ title: "t", input: "", labels: [], status: "todo" });
  assert.equal(created.title, "t");
  assert.deepEqual(inner.writes, []);
  assert.match(printed[0] ?? "", /^DRY update-task a \{"status":"running"\}$/);
  assert.match(printed[1] ?? "", /^DRY add-note a hello$/);
  assert.match(printed[2] ?? "", /^DRY add-task /);
});
