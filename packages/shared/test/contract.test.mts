import assert from "node:assert/strict";
import { test } from "node:test";
import { ContractError, parseDraft, parseHeartbeat, parseNote, parsePatch, parseTask } from "../src/contract.mts";

const task = {
  id: "Ab3dEf9x",
  title: "#1 t",
  input: "https://github.com/o/r/pull/1",
  labels: ["review-pr"],
  status: "todo",
  priority: "normal",
  url: "https://board.example/t/Ab3dEf9x",
  closed: false,
  machine: null,
  sessionId: null,
  workdir: null,
  next: "fresh",
  openQuestion: false,
  lane: null,
  borrowed: false,
  lastActiveAt: null,
};

test("a v2 task needs every field", () => {
  assert.deepEqual(parseTask(task), task);
  const { next: _next, ...withoutNext } = task;
  assert.throws(() => parseTask(withoutNext), /next must be one of/);
  assert.throws(() => parseTask({ ...task, machine: "bad name" }), /not a safe name/);
});

test("a running task carries its lane and liveness", () => {
  const running = parseTask({ ...task, status: "running", lane: "reviews", borrowed: true, lastActiveAt: "2026-11-13T10:00:00Z" });
  assert.equal(running.lastActiveAt?.toISOString(), "2026-11-13T10:00:00.000Z");
  assert.throws(() => parseTask({ ...task, lastActiveAt: "soon" }), /lastActiveAt is not a date/);
  assert.deepEqual(parseHeartbeat({ lane: "reviews", borrowed: false }), { lane: "reviews", borrowed: false });
  assert.throws(() => parseHeartbeat({ lane: "a b", borrowed: false }), /heartbeat.lane/);
});

test("a draft takes the dedupe key, parent and creator; unknown keys fail", () => {
  assert.deepEqual(parseDraft({ title: "t", dedupeKey: "k", parentId: "abc", createdBy: "agent" }), {
    title: "t",
    input: "",
    labels: [],
    status: "todo",
    dedupeKey: "k",
    parentId: "abc",
    createdBy: "agent",
  });
  assert.throws(() => parseDraft({ title: "t", rank: 1 }), ContractError);
  assert.equal(parseDraft({ title: "t", priority: "high" }).priority, "high");
  assert.equal(parseDraft({ title: "t" }).priority, undefined, "the store picks the default, so a follow-up can inherit");
});

test("a patch takes the session and the next run", () => {
  assert.deepEqual(parsePatch({ sessionId: null, next: "resume" }), { sessionId: null, next: "resume" });
  assert.throws(() => parsePatch({}), /patch needs one of/);
  assert.throws(() => parsePatch({ next: "later" }), /next must be one of/);
  assert.deepEqual(parsePatch({ priority: "urgent" }), { priority: "urgent" });
  assert.deepEqual(parsePatch({ workdir: "/repo/.claude/worktrees/x" }), { workdir: "/repo/.claude/worktrees/x" });
  assert.throws(() => parsePatch({ workdir: "relative/dir" }), /absolute path/);
  assert.throws(() => parsePatch({ priority: "asap" }), /priority must be one of urgent, high, normal, low/);
});

test("question and answer notes carry their structure", () => {
  const question = parseNote({
    id: "n1",
    text: "",
    createdAt: "2026-11-13T10:00:00Z",
    author: "agent",
    kind: "question",
    questions: [{ header: "Scope", question: "Q?", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }],
  });
  assert.equal(question.questions?.[0]?.header, "Scope");
  const answer = parseNote({ id: "n2", text: "", createdAt: "2026-11-13T10:01:00Z", author: "user", kind: "answer", questionNoteId: "n1", answers: [{ selected: ["A"] }] });
  assert.deepEqual(answer.answers, [{ selected: ["A"] }]);
  assert.throws(() => parseNote({ id: "n3", text: "", createdAt: "nope", author: "agent", kind: "comment" }), /not a date/);
});
