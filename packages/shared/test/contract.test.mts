import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ContractError,
  parseDraft,
  parseFailResult,
  parseHeartbeat,
  parseNote,
  parsePatch,
  parseAddScheduleResult,
  parseSchedule,
  parseScheduleDraft,
  parseSchedulePatch,
  parseTask,
  promptSkill,
  serializeSchedule,
  serializeTask,
  shortSkill,
} from '../src/contract.mts';
import { describeRule, runsLeft } from '../src/time.mts';

const task = {
  id: 'Ab3dEf9x',
  title: '#1 t',
  input: 'https://github.com/o/r/pull/1',
  labels: ['review-pr'],
  status: 'todo',
  priority: 'normal',
  url: 'https://board.example/t/Ab3dEf9x',
  closed: false,
  machine: null,
  sessionId: null,
  workdir: null,
  next: 'fresh',
  head: null,
  openQuestion: false,
  createdBy: 'user',
  lane: null,
  borrowed: false,
  lastActiveAt: null,
  runStartedAt: null,
  paused: false,
  notBefore: null,
  scheduleId: null,
};

test('a task needs every field', () => {
  assert.deepEqual(parseTask(task), task);
  const { next: _next, ...withoutNext } = task;
  assert.throws(() => parseTask(withoutNext), /next must be one of/);
  assert.throws(() => parseTask({ ...task, machine: 'bad name' }), /not a safe name/);
});

test('a running task carries its lane, liveness and start', () => {
  const running = parseTask({
    ...task,
    status: 'running',
    lane: 'reviews',
    borrowed: true,
    lastActiveAt: '2026-11-13T10:00:00Z',
    runStartedAt: '2026-11-13T09:00:00Z',
    paused: true,
  });
  assert.equal(running.lastActiveAt?.toISOString(), '2026-11-13T10:00:00.000Z');
  assert.equal(running.runStartedAt?.toISOString(), '2026-11-13T09:00:00.000Z');
  assert.equal(running.paused, true);
  assert.throws(() => parseTask({ ...task, lastActiveAt: 'soon' }), /lastActiveAt is not a date/);
  assert.deepEqual(parseHeartbeat({ lane: 'reviews', borrowed: false }), { lane: 'reviews', borrowed: false });
  assert.throws(() => parseHeartbeat({ lane: 'a b', borrowed: false }), /heartbeat.lane/);
});

test('a draft takes the dedupe key, parent and creator; unknown keys fail', () => {
  assert.deepEqual(parseDraft({ title: 't', dedupeKey: 'k', parentId: 'abc', createdBy: 'agent' }), {
    title: 't',
    input: '',
    labels: [],
    status: 'todo',
    dedupeKey: 'k',
    parentId: 'abc',
    createdBy: 'agent',
  });
  assert.equal(parseDraft({ title: 't', status: 'backlog' }).status, 'backlog');
  assert.deepEqual(parsePatch({ status: 'backlog' }), { status: 'backlog' });
  assert.throws(() => parseDraft({ title: 't', rank: 1 }), ContractError);
  assert.equal(parseDraft({ title: 't', priority: 'high' }).priority, 'high');
  assert.equal(
    parseDraft({ title: 't' }).priority,
    undefined,
    'the store picks the default, so a follow-up can inherit',
  );
});

test('a patch takes the session and the next run', () => {
  assert.deepEqual(parsePatch({ sessionId: null, next: 'resume' }), { sessionId: null, next: 'resume' });
  assert.throws(() => parsePatch({}), /patch needs one of/);
  assert.throws(() => parsePatch({ next: 'later' }), /next must be one of/);
  assert.deepEqual(parsePatch({ priority: 'urgent' }), { priority: 'urgent' });
  assert.deepEqual(parsePatch({ status: 'done', expect: 'todo' }), { status: 'done', expect: 'todo' });
  assert.throws(() => parsePatch({ expect: 'todo' }), /patch needs one of/);
  assert.throws(() => parsePatch({ next: 'fresh', expect: 'later' }), /expect must be one of/);
  assert.deepEqual(parsePatch({ workdir: '/repo/.claude/worktrees/x' }), { workdir: '/repo/.claude/worktrees/x' });
  assert.throws(() => parsePatch({ workdir: 'relative/dir' }), /absolute path/);
  assert.throws(() => parsePatch({ priority: 'asap' }), /priority must be one of urgent, high, normal, low/);
});

test('question and answer notes carry their structure', () => {
  const question = parseNote({
    id: 'n1',
    text: '',
    createdAt: '2026-11-13T10:00:00Z',
    author: 'agent',
    kind: 'question',
    questions: [
      {
        header: 'Scope',
        question: 'Q?',
        options: [
          { label: 'A', description: '' },
          { label: 'B', description: '' },
        ],
      },
    ],
  });
  assert.equal(question.questions?.[0]?.header, 'Scope');
  const answer = parseNote({
    id: 'n2',
    text: '',
    createdAt: '2026-11-13T10:01:00Z',
    author: 'user',
    kind: 'answer',
    questionNoteId: 'n1',
    answers: [{ selected: ['A'] }],
  });
  assert.deepEqual(answer.answers, [{ selected: ['A'] }]);
  assert.throws(
    () => parseNote({ id: 'n3', text: '', createdAt: 'nope', author: 'agent', kind: 'comment' }),
    /not a date/,
  );
});

test('the skill of a prompt is its leading slash command', () => {
  assert.equal(promptSkill('/review-pr 17741'), 'review-pr');
  assert.equal(promptSkill('  /pr-review:review-pr https://x --auto\nhead: abc'), 'pr-review:review-pr');
  assert.equal(promptSkill('/grill'), 'grill');
  assert.equal(promptSkill('Find out why /tmp fills up'), undefined);
  assert.equal(promptSkill('/ not a skill'), undefined);
  assert.equal(shortSkill('pr-review:review-pr'), 'review-pr');
  assert.equal(shortSkill('review-pr'), 'review-pr');
});

test('a draft pins to a machine and directory together', () => {
  assert.deepEqual(parseDraft({ title: 't', machine: 'laptop', workdir: '/repo' }), {
    title: 't',
    input: '',
    labels: [],
    status: 'todo',
    machine: 'laptop',
    workdir: '/repo',
  });
  assert.throws(() => parseDraft({ title: 't', workdir: '/repo' }), /go together/);
  assert.throws(() => parseDraft({ title: 't', machine: 'laptop', workdir: 'repo' }), /absolute path/);
});

test('the PR head is 7 to 40 hex characters, on a task, a draft and a patch', () => {
  assert.equal(parseTask({ ...task, head: '56120dc' }).head, '56120dc');
  assert.throws(() => parseTask({ ...task, head: 'xyz' }), /head must be 7 to 40 hex/);
  assert.throws(() => parseTask({ ...task, head: undefined }), /head must be 7 to 40 hex/);
  assert.equal(parseDraft({ title: 't', head: '56120dc60b' }).head, '56120dc60b');
  assert.throws(() => parseDraft({ title: 't', head: null }), /head must be/);
  assert.deepEqual(parsePatch({ head: '56120dc60b' }), { head: '56120dc60b' });
  assert.deepEqual(parsePatch({ head: null }), { head: null });
  assert.throws(() => parsePatch({ head: 'abc' }), /head must be/);
});

test('a fail result says whether it applied', () => {
  assert.deepEqual(parseFailResult({ applied: false, task }), { applied: false, task });
  assert.throws(() => parseFailResult({ task }), /applied must be a boolean/);
});

test('notBefore is a date on a task, a draft and a patch', () => {
  const waiting = parseTask({ ...task, notBefore: '2027-01-01T12:00:00Z' });
  assert.equal(waiting.notBefore?.toISOString(), '2027-01-01T12:00:00.000Z');
  assert.deepEqual(parseTask(serializeTask(waiting)), waiting);
  assert.throws(() => parseTask({ ...task, notBefore: 'later' }), /notBefore is not a date/);
  assert.throws(() => parseTask({ ...task, notBefore: undefined }), /notBefore must be a string or null/);

  assert.equal(
    parseDraft({ title: 't', notBefore: '2027-01-01T12:00:00Z' }).notBefore?.toISOString(),
    '2027-01-01T12:00:00.000Z',
  );
  assert.throws(() => parseDraft({ title: 't', notBefore: null }), /must be a date/);
  assert.throws(
    () => parseDraft({ title: 't', status: 'backlog', notBefore: '2027-01-01T12:00:00Z' }),
    /needs status todo/,
  );

  assert.equal(parsePatch({ notBefore: '2027-01-01T12:00:00Z' }).notBefore?.toISOString(), '2027-01-01T12:00:00.000Z');
  assert.deepEqual(parsePatch({ notBefore: null }), { notBefore: null });
});

const schedule = {
  id: 'Sc3dEf9x',
  title: 'Nightly sweep',
  input: '/sweep',
  priority: 'normal',
  machine: null,
  workdir: null,
  everyMs: 7_200_000,
  cron: null,
  timezone: null,
  anchorAt: '2027-01-01T08:00:00.000Z',
  nextRunAt: '2027-01-01T08:00:00.000Z',
  remaining: null,
  until: null,
  paused: false,
  ended: false,
  occurrenceTaskId: 'Ab3dEf9x',
  createdAt: '2026-11-14T10:00:00.000Z',
};

test('a task carries the schedule it is an occurrence of; a draft cannot set it', () => {
  assert.equal(parseTask({ ...task, scheduleId: 'Sc3dEf9x' }).scheduleId, 'Sc3dEf9x');
  assert.throws(() => parseTask({ ...task, scheduleId: 'bad id' }), /not safe/);
  assert.throws(() => parseDraft({ title: 't', scheduleId: 'Sc3dEf9x' }), /unknown key "scheduleId"/);
  assert.throws(() => parsePatch({ scheduleId: null }), /unknown key "scheduleId"/);
  assert.equal(serializeTask(parseTask({ ...task, scheduleId: 'Sc3dEf9x' }))['scheduleId'], 'Sc3dEf9x');
});

test('a schedule round-trips through parse and serialize, for both kinds of rule', () => {
  assert.deepEqual(serializeSchedule(parseSchedule(schedule)), schedule);
  const cron = {
    ...schedule,
    everyMs: null,
    cron: '0 9 * * 1-5',
    timezone: 'Europe/Berlin',
    remaining: 0,
    until: '2027-06-01T00:00:00.000Z',
    nextRunAt: null,
    paused: true,
    occurrenceTaskId: null,
  };
  assert.deepEqual(serializeSchedule(parseSchedule(cron)), cron);
});

test('a schedule has exactly one rule, and a cron rule a time zone', () => {
  assert.throws(() => parseSchedule({ ...schedule, cron: '0 9 * * *', timezone: 'UTC' }), /exactly one/);
  assert.throws(() => parseSchedule({ ...schedule, everyMs: null }), /exactly one/);
  assert.throws(() => parseSchedule({ ...schedule, everyMs: null, cron: '0 9 * * *' }), /timezone is required/);
  assert.throws(() => parseSchedule({ ...schedule, everyMs: 0 }), /positive integer/);
});

test('add-schedule results carry the schedule and its pending task', () => {
  const result = parseAddScheduleResult({ schedule, task: { ...task, scheduleId: 'Sc3dEf9x' } });
  assert.equal(result.schedule.id, 'Sc3dEf9x');
  assert.equal(result.task.scheduleId, 'Sc3dEf9x');
});

test('describeRule names an interval or a cron rule with its time zone', () => {
  assert.equal(describeRule(parseSchedule(schedule)), 'every 2h');
  assert.equal(
    describeRule({ everyMs: null, cron: '0 9 * * 1-5', timezone: 'Europe/Berlin' }),
    'cron 0 9 * * 1-5 (Europe/Berlin)',
  );
});

test('runsLeft counts the pending run and is null for a schedule that repeats forever', () => {
  assert.equal(runsLeft({ remaining: null, occurrenceTaskId: 'a' }), null);
  assert.equal(runsLeft({ remaining: 2, occurrenceTaskId: 'a' }), 3);
  assert.equal(runsLeft({ remaining: 2, occurrenceTaskId: null }), 2);
  assert.equal(runsLeft({ remaining: 0, occurrenceTaskId: null }), 0);
});

test('a schedule draft needs a prompt and one rule', () => {
  const draft = { title: 't', input: 'do it', everyMs: 3_600_000 };
  assert.deepEqual(parseScheduleDraft(draft), draft);
  assert.deepEqual(
    parseScheduleDraft({
      title: 't',
      input: 'x',
      cron: '0 9 * * *',
      timezone: 'UTC',
      times: 3,
      startAt: '2027-01-01T00:00:00Z',
    }),
    { title: 't', input: 'x', cron: '0 9 * * *', timezone: 'UTC', times: 3, startAt: new Date('2027-01-01T00:00:00Z') },
  );
  assert.throws(() => parseScheduleDraft({ title: 't', input: 'x' }), /exactly one of everyMs and cron/);
  assert.throws(() => parseScheduleDraft({ ...draft, cron: '* * * * *', timezone: 'UTC' }), /exactly one/);
  assert.throws(() => parseScheduleDraft({ title: 't', input: 'x', cron: '0 9 * * *' }), /timezone must be a string/);
  assert.throws(() => parseScheduleDraft({ ...draft, timezone: 'UTC' }), /only goes with cron/);
  assert.throws(() => parseScheduleDraft({ ...draft, times: 0 }), /positive integer/);
  assert.throws(() => parseScheduleDraft({ ...draft, times: 2, until: '2027-01-01T00:00:00Z' }), /exclude each other/);
  assert.throws(() => parseScheduleDraft({ ...draft, machine: 'laptop' }), /go together/);
  assert.throws(() => parseScheduleDraft({ ...draft, id: 'x' }), /unknown key "id"/);
  assert.throws(() => parseScheduleDraft({ ...draft, input: ' ' }), /must not be empty/);
});

test('a schedule patch is a paused flag', () => {
  assert.deepEqual(parseSchedulePatch({ paused: true }), { paused: true });
  assert.throws(() => parseSchedulePatch({}), /paused must be a boolean/);
  assert.throws(() => parseSchedulePatch({ paused: true, title: 'x' }), /unknown key/);
});
