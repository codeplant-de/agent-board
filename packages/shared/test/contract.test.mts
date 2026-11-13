import assert from "node:assert/strict";
import { test } from "node:test";
import { ContractError, parseDraft, parseNote, parsePatch, parseTask } from "../src/contract.mts";

const task = {
  id: "Ab3dEf9x",
  title: "#1 t",
  input: "https://github.com/o/r/pull/1",
  labels: ["review-pr"],
  status: "todo",
  url: "https://board.example/t/Ab3dEf9x",
  closed: false,
  machine: null,
  sessionId: null,
  next: "fresh",
  openQuestion: false,
};

test("a v2 task needs every field", () => {
  assert.deepEqual(parseTask(task), task);
  const { next: _next, ...withoutNext } = task;
  assert.throws(() => parseTask(withoutNext), /next must be one of/);
  assert.throws(() => parseTask({ ...task, machine: "bad name" }), /not a safe name/);
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
});

test("a patch takes the session and the next run", () => {
  assert.deepEqual(parsePatch({ sessionId: null, next: "resume" }), { sessionId: null, next: "resume" });
  assert.throws(() => parsePatch({}), /patch needs one of/);
  assert.throws(() => parsePatch({ next: "later" }), /next must be one of/);
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
