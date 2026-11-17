import assert from 'node:assert/strict';
import { test } from 'node:test';
import { note as makeNote, SESSION, task } from '../__tests__/helpers/fakes.mts';
import { START_MARKER } from '../task-rules.mts';
import {
  boardRules,
  buildResumePrompt,
  freshThreadBlock,
  inboxMessageText,
  pauseMessageText,
  userReply,
} from './prompts.mts';
import { tail } from '../output/text.mts';

test("the board's rules tell the agent to attach the user's likely next reply to its final comment", () => {
  assert.match(
    boardRules(task({ id: 'abc' })),
    /board comment --suggest "<reply>" abc "<summary>".*Skip it when no single reply is obvious.*refuses `--suggest`.*without it/s,
  );
});

test("the board's rules tell the agent to report the PR it opens, except in an agent's run", () => {
  assert.match(boardRules(task({ id: 'abc' })), /open a pull request.*board pr abc <url>/s);
  assert.match(
    boardRules(task({ id: 'abc' })),
    /Report every pull request you open or work on for this task, each with its own `board pr abc <url>` call/,
  );
  assert.doesNotMatch(boardRules(task({ id: 'abc' })), /replaces the earlier/);
  assert.doesNotMatch(boardRules(task({ id: 'abc' }), { asAgent: true }), /board pr/);
});

test("the board's rules tell the agent to ask through the board, and an agent's run to keep its commands simple", () => {
  assert.match(
    boardRules(task({ id: 'abc' })),
    /AskUserQuestion is not available.*board ask abc --file \/tmp\/pr-abc-questions\.json/s,
  );
  assert.doesNotMatch(boardRules(task({ id: 'abc' })), /stands alone/);
  assert.match(boardRules(task({ id: 'abc' }), { asAgent: true }), /run every Bash command on its own, without pipes/);
});

test("the board's rules let the agent act alone on local, reversible steps and ask before visible or lasting ones", () => {
  const rules = boardRules(task({ id: 'abc' }));
  assert.match(rules, /Decide and act without asking on whatever is easy to undo and stays on this machine/);
  assert.match(
    rules,
    /Use `board ask` only before a step that is hard to undo or that other people see.*force-pushing.*merging/s,
  );
  assert.doesNotMatch(boardRules(task({ id: 'abc' }), { asAgent: true }), /Work on your own/);
});

test("the board's rules make an implementation task end in a pushed branch, a PR and CI", () => {
  const rules = boardRules(task({ id: 'abc' }));
  assert.match(rules, /implement, fix or change code.*request to commit, push and open a PR/s);
  assert.match(
    rules,
    /never the default branch.*git push -u origin HEAD.*gh pr create.*started or approved by hand.*Wait for CI.*PR link in your final `board comment`/s,
  );
  assert.match(rules, /only for a plan, an investigation or a review opens no PR/);
  assert.doesNotMatch(boardRules(task({ id: 'abc' }), { asAgent: true }), /gh pr create/);
});

test("the board's rules tell the agent not to end its turn while background work runs", () => {
  assert.match(boardRules(task({ id: 'abc' })), /Do not end your turn while a background agent .* in the foreground/s);
});

test('long text is tailed', () => {
  assert.equal(tail('abcdef', 4), '…def');
});

test('the run rules tell the agent to wait with board wait instead of polling', () => {
  const rules = boardRules(task({ id: 'r' }));
  assert.match(rules, /board wait r --check '<command>'/);
  assert.match(rules, /board wait r --in 30m/);
});

const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 13, 10, minute));

const start = (iso: number) => makeNote(`${START_MARKER} x`, at(iso), { author: 'system', kind: 'event' });

test('earlier findings alone point the fresh run at the thread; a first message on a never-run task is carried whole', () => {
  assert.equal(
    freshThreadBlock(task({ id: 'a', runStartedAt: at(20) }), [start(1), makeNote('Findings', at(5)), start(10)]),
    'The thread holds earlier notes: run `board show a` first to read it.',
  );
  const proposal = freshThreadBlock(task({ id: 'a' }), [makeNote('start with the API', at(1), { author: 'user' })]);
  assert.match(proposal ?? '', /start with the API/);
});

test('a reply leaves out the notes the agent was handed while it ran, and the resume prompt does not repeat them', () => {
  const user = (text: string, minute: number, extra: Partial<Parameters<typeof makeNote>[2]> = {}) =>
    makeNote(text, at(minute), { author: 'user', ...extra });
  const notes = [
    makeNote('Working on it', at(1), { author: 'agent' }),
    user('handed over mid-run', 2, { deliveredAt: at(3) }),
    user('said after the stop', 4),
  ];
  assert.deepEqual(
    userReply(notes).map((note) => note.text),
    ['said after the stop'],
  );
  const prompt = buildResumePrompt(task({ id: 'p', next: 'resume', sessionId: SESSION }), notes);
  assert.match(prompt ?? '', /said after the stop/);
  assert.doesNotMatch(prompt ?? '', /handed over mid-run/);
  assert.equal(
    buildResumePrompt(task({ id: 'p', next: 'resume', sessionId: SESSION }), notes.slice(0, 2)),
    undefined,
    'a thread whose only reply was handed over has nothing to resume with',
  );
});

test('a resume carries the messages the agent was never handed, even from before its last note, once', () => {
  const user = (text: string, minute: number, extra: Partial<Parameters<typeof makeNote>[2]> = {}) =>
    makeNote(text, at(minute), { author: 'user', ...extra });
  const start = (minute: number) =>
    makeNote(`${START_MARKER} on laptop`, at(minute), { author: 'system', kind: 'event' });
  const notes = [
    user('before the previous run', 0, { queued: true }),
    start(1),
    user('never handed over', 2, { queued: true }),
    user('handed over', 3, { queued: true, deliveredAt: at(4) }),
    makeNote('Done, here is the summary', at(5), { author: 'agent' }),
    user('and after it', 6),
    start(7),
  ];
  const reply = userReply(notes, at(7));
  assert.deepEqual(
    reply.map((note) => note.text),
    ['never handed over', 'and after it'],
  );
  const ordinary = userReply(
    [...notes.slice(0, 6)].map((n) => (n.text === 'and after it' ? { ...n, queued: true } : n)),
    at(7),
  );
  assert.equal(new Set(ordinary.map((n) => n.id)).size, ordinary.length, 'a note found twice is listed once');
});

test('the messages an agent is sent say who wrote them, and an interruption says it was one', () => {
  const message = makeNote('use the other table', at(1), { author: 'user' });
  assert.match(
    inboxMessageText('abc', message, false),
    /sent you a message on board task abc while you work:\n\nuse the other table/,
  );
  assert.match(
    inboxMessageText('abc', message, true),
    /interrupted you on board task abc to correct you:\n\nuse the other table/,
  );
  assert.match(pauseMessageText('abc'), /Pause requested.*`board comment abc "..."`.*end your turn/);
});
