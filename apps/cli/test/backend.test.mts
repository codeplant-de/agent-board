import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BackendError, createCliBackend, dryRunBackend } from "../src/backend.mts";
import { isSafeTaskId } from "@agent-board/shared";
import type { Backend } from "@agent-board/shared";
import { fakeBackend, task } from "./helpers.mts";

const FIXTURE = new URL("./fixtures/fake-backend.mts", import.meta.url).pathname;

function setup(mode = "", timeoutMs?: number, maxOutputChars?: number): { backend: Backend; stateFile: string } {
  const stateFile = join(mkdtempSync(join(tmpdir(), "agent-board-backend-")), "state.json");
  writeFileSync(stateFile, JSON.stringify({ tasks: [], notes: {}, calls: [] }));
  process.env["FAKE_BACKEND_FILE"] = stateFile;
  process.env["FAKE_BACKEND_MODE"] = mode;
  return { backend: createCliBackend({ command: [process.execPath, FIXTURE], timeoutMs, maxOutputChars }), stateFile };
}

function calls(stateFile: string): { argv: string[]; stdin: string }[] {
  const raw: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
  return typeof raw === "object" && raw !== null && "calls" in raw && Array.isArray(raw.calls) ? raw.calls : [];
}

test("all operations round trip through the CLI", async () => {
  const { backend } = setup();
  const { task: created } = await backend.addTask({ title: "PR 1", input: "https://x/1\nhead: abc1234", labels: ["review-pr"], status: "todo" });
  assert.equal(created.status, "todo");
  assert.deepEqual((await backend.listTasks()).map((t) => t.id), [created.id]);
  assert.equal((await backend.getTask(created.id)).input, "https://x/1\nhead: abc1234");
  const updated = await backend.updateTask(created.id, { status: "running" });
  assert.equal(updated.status, "running");
  await backend.addNote(created.id, "first");
  await backend.addNote(created.id, "second");
  await backend.addNote(created.id, "third", { author: "system" });
  const notes = await backend.readNotes(created.id);
  assert.deepEqual(notes.map((n) => n.text), ["first", "second", "third"]);
  assert.deepEqual(notes.map((n) => n.author), ["agent", "agent", "system"]);
  assert.ok(notes[0]?.createdAt instanceof Date);
  assert.deepEqual(await backend.setup(["review-pr"]), ["list Todo"]);
});

test("closed tasks only come with all", async () => {
  const { backend, stateFile } = setup();
  const { task: created } = await backend.addTask({ title: "t", input: "", labels: [], status: "done" });
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.tasks[0].closed = true;
  writeFileSync(stateFile, JSON.stringify(state));
  assert.deepEqual(await backend.listTasks(), []);
  assert.deepEqual((await backend.listTasks({ all: true })).map((t) => t.id), [created.id]);
});

test("free text travels on stdin, never in argv", async () => {
  const { backend, stateFile } = setup();
  const { task: { id } } = await backend.addTask({ title: "SECRET-TITLE", input: "SECRET-INPUT", labels: [], status: "todo" });
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
  await assert.rejects(other.backend.listTasks(), /speaks contract 1, this core needs 2/);
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
  const { task: created } = await dry.addTask({ title: "t", input: "", labels: [], status: "todo" });
  assert.equal(created.title, "t");
  assert.deepEqual(inner.writes, []);
  assert.match(printed[0] ?? "", /^DRY update-task a \{"status":"running"\}$/);
  assert.match(printed[1] ?? "", /^DRY add-note a hello$/);
  assert.match(printed[2] ?? "", /^DRY add-task /);
});

test("the reason shown is the start of the backend's stderr, not the end", async () => {
  await assert.rejects(setup("noisy-fail").backend.listTasks(), (error: Error) => /exit 4\): FIRST-LINE-REASON/.test(error.message) && !error.message.includes("LAST-LINE"));
});

test("a task with a url Slack could misread is refused", async () => {
  const { backend, stateFile } = setup();
  const { task: created } = await backend.addTask({ title: "t", input: "", labels: [], status: "todo" });
  for (const url of ["javascript:alert(1)", "https://x.example/a|b", "https://x.example/<a>", "https://x.example/a b", "", "ftp://x.example/a"]) {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.tasks[0].url = url;
    writeFileSync(stateFile, JSON.stringify(state));
    await assert.rejects(backend.getTask(created.id), /task url/, url);
  }
});

test("the ids dispatch and intake are refused, they would collide with the tool's own units", async () => {
  const { backend, stateFile } = setup();
  for (const id of ["dispatch", "intake"]) await assert.rejects(backend.getTask(id), /not a valid task id/);
  assert.deepEqual(calls(stateFile), []);
  assert.equal(isSafeTaskId("dispatcher"), true);
});

test("concurrent calls on the fake backend lose nothing, and a status change goes to the bottom", async () => {
  const { backend } = setup();
  const [first, second] = [(await backend.addTask({ title: "a", input: "", labels: [], status: "todo" })).task, (await backend.addTask({ title: "b", input: "", labels: [], status: "todo" })).task];
  await Promise.all([
    ...Array.from({ length: 8 }, (_, i) => backend.addNote(first.id, `note ${i}`)),
    ...Array.from({ length: 8 }, (_, i) => backend.addTask({ title: `c${i}`, input: "", labels: [], status: "todo" })),
  ]);
  assert.equal((await backend.readNotes(first.id)).length, 8);
  const ids = (await backend.listTasks()).map((t) => t.id);
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10, "every task got its own id");
  await backend.updateTask(first.id, { status: "todo" });
  const after = await backend.listTasks();
  assert.equal(after.at(-1)?.id, first.id);
  assert.equal(after[0]?.id, second.id);
});

test("update-task refuses keys it does not know", () => {
  const { stateFile } = setup();
  const created = spawnSync(process.execPath, [FIXTURE, "add-task"], { input: '{"title":"t"}', encoding: "utf8", env: process.env });
  assert.equal(created.status, 0);
  const result = spawnSync(process.execPath, [FIXTURE, "update-task", "t1"], { input: '{"title":"renamed"}', encoding: "utf8", env: process.env });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown key "title"/);
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).tasks[0].title, "t");
});

// A backend that is a shell wrapper around a long-running child (no exec): the wrapper dies at the kill, and the
// child must go with it.
function wrapperBackend(body: string): { command: string[]; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-board-wrapper-"));
  const pidFile = join(dir, "child.pid");
  const script = join(dir, "backend");
  writeFileSync(script, `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\n${body}\n`);
  chmodSync(script, 0o755);
  return { command: [script], pidFile };
}

async function assertGone(pidFile: string): Promise<void> {
  const child = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(child > 0);
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(child, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("the backend's child is still running");
}

test("a timeout kills the backend's children too, and does not wait for pipes they hold", async () => {
  const { command, pidFile } = wrapperBackend("wait");
  const started = Date.now();
  await assert.rejects(createCliBackend({ command, timeoutMs: 400 }).listTasks(), /timed out after 0.4s/);
  assert.ok(Date.now() - started < 5_000);
  await assertGone(pidFile);
});

test("the output cap kills the backend's children too", async () => {
  const { command, pidFile } = wrapperBackend("yes x");
  const started = Date.now();
  await assert.rejects(createCliBackend({ command, maxOutputChars: 1_000 }).listTasks(), /printed more than 1000 characters/);
  assert.ok(Date.now() - started < 5_000);
  await assertGone(pidFile);
});

test("a backend setup that is only planned writes nothing, and dry run prints the plan", async () => {
  const { backend, stateFile } = setup();
  const printed: string[] = [];
  const dry = dryRunBackend(backend, (line) => printed.push(line));
  assert.deepEqual(await dry.setup(["review-pr"]), []);
  assert.deepEqual(printed, ["DRY create list Todo"]);
  assert.deepEqual(await backend.setup(["review-pr"]), ["list Todo"], "the dry run did not create it");
  assert.deepEqual(calls(stateFile).map((call) => call.argv.join(" ")).filter((line) => line.startsWith("setup")), ["setup --dry-run", "setup"]);
  assert.equal(await setup("no-setup").backend.setup([], { dryRun: true }), undefined);
});

test("a claim moves a todo task to running for the machine, and a lost claim is undefined", async () => {
  const { backend } = setup();
  const { task: created } = await backend.addTask({ title: "t", input: "", labels: [], status: "todo" });
  const claimed = await backend.claimTask(created.id, "laptop");
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.machine, "laptop");
  assert.equal(await backend.claimTask(created.id, "workstation"), undefined);
  await assert.rejects(backend.claimTask(created.id, "bad name"), /not a valid machine name/);
});

test("a second add-task with the same dedupe key returns the first task", async () => {
  const { backend } = setup();
  const first = await backend.addTask({ title: "a", input: "", labels: [], status: "todo", dedupeKey: "https://x/1" });
  const second = await backend.addTask({ title: "b", input: "", labels: [], status: "todo", dedupeKey: "https://x/1" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.task.id, first.task.id);
});

test("ask puts a question note on the task and moves it to needs-me", async () => {
  const { backend, stateFile } = setup();
  const { task: created } = await backend.addTask({ title: "t", input: "", labels: [], status: "running" });
  const questions = [{ header: "Scope", question: "Q?", multiSelect: false, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }];
  await backend.ask(created.id, questions);
  const after = await backend.getTask(created.id);
  assert.equal(after.status, "needs-me");
  assert.equal(after.openQuestion, true);
  const [question] = await backend.readNotes(created.id);
  assert.equal(question?.kind, "question");
  assert.deepEqual(question?.questions, questions);
  const call = calls(stateFile).find((c) => c.argv[0] === "ask");
  assert.deepEqual(call?.argv, ["ask", created.id]);
});
