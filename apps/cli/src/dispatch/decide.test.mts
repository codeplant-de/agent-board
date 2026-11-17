import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideStale, decideWake, notServableHere, planPauses, planStarts } from './decide.mts';
import type { LaneRun } from './decide.mts';
import { SESSION, task } from '../__tests__/helpers/fakes.mts';

const PR = 'https://github.com/cosuno/cosuno/pull/17741';

const NO_AGENTS = { agents: {}, agentErrors: {} };

test('a machine leaves a task to another when it names an agent this machine lacks', () => {
  const agent = { description: 'd', tools: ['Read'], allowedTools: [], disallowedTools: [], env: [], mcpServers: [] };
  const named = task({ id: 'a', input: `/review-pr ${PR} --auto`, agent: 'reviewer', createdBy: 'intake' });
  assert.equal(notServableHere(named, 'here', { agents: { reviewer: agent }, agentErrors: {} }), undefined);
  assert.equal(notServableHere(named, 'here', NO_AGENTS), 'no agent reviewer defined here');
});

test('an intake task without an agent is claimed by any machine, so that its worker fails it with the reason', () => {
  const old = task({ id: 'a', input: `/review-pr ${PR} --auto`, createdBy: 'intake' });
  assert.equal(notServableHere(old, 'here', NO_AGENTS), undefined);
});

test('a machine leaves a task to another when it is pinned there', () => {
  const here = (overrides: Parameters<typeof task>[0]) => notServableHere(task(overrides), 'here', NO_AGENTS);
  assert.equal(here({ id: 'a', input: 'Find out X' }), undefined);
  assert.match(here({ id: 'a', input: '/grill', machine: 'there', workdir: '/x' }) ?? '', /pinned to there/);
  assert.equal(here({ id: 'a', input: '/grill', machine: 'here', workdir: '/x' }), undefined);
  assert.match(
    here({ id: 'a', input: '/grill', next: 'resume', sessionId: SESSION, machine: 'there' }) ?? '',
    /pinned to there/,
  );
});

const at = (minute: number): Date => new Date(Date.UTC(2026, 10, 13, 10, minute));

const NOW = new Date('2026-01-01T12:00:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const LIMITS = { inactivityMinutes: 15, maxRunHours: 6 };

test('stale: after a gap between ticks the quiet time is not counted, the dead worker and the hour limit still are', () => {
  const quiet = { unitActive: true, startedAt: ago(300), lastActive: ago(180), now: NOW, limits: LIMITS };
  assert.equal(decideStale(quiet).stale, true, 'three quiet hours are stale on an ordinary tick');
  assert.equal(decideStale({ ...quiet, afterGap: true }).stale, false, 'but not on the tick after the machine slept');
  assert.equal(decideStale({ ...quiet, afterGap: true, unitActive: false }).stale, true);
  assert.equal(decideStale({ ...quiet, afterGap: true, startedAt: ago(7 * 60) }).stale, true);
});

test('stale: a gone unit at once; an active one only past the limits plus grace', () => {
  const gone = decideStale({ unitActive: false, startedAt: NOW, lastActive: undefined, now: NOW, limits: LIMITS });
  assert.equal(gone.stale && !gone.stopUnit, true);
  assert.equal(
    decideStale({ unitActive: true, startedAt: ago(300), lastActive: ago(19), now: NOW, limits: LIMITS }).stale,
    false,
  );
  const quiet = decideStale({ unitActive: true, startedAt: ago(300), lastActive: ago(21), now: NOW, limits: LIMITS });
  assert.equal(quiet.stale && quiet.stopUnit, true);
  assert.equal(
    decideStale({ unitActive: true, startedAt: ago(6 * 60 + 6), lastActive: ago(0), now: NOW, limits: LIMITS }).stale,
    true,
  );
  assert.equal(
    decideStale({ unitActive: true, startedAt: undefined, lastActive: undefined, now: NOW, limits: LIMITS }).stale,
    false,
  );
});

const LANES = [
  { name: 'reviews', skills: ['review-pr'], slots: 2 },
  { name: 'implement', skills: ['implement'], slots: 1 },
];
const lane = (t: { labels: string[] }) => LANES.find((l) => l.skills.includes(t.labels[0] ?? ''))?.name;
const run = (
  taskId: string,
  laneName: string,
  borrowed: boolean,
  minutesAgo: number,
  pauseRequested = false,
): LaneRun => ({ taskId, lane: laneName, borrowed, startedAt: ago(minutesAgo), pauseRequested });

test('lanes take their own work first, then idle lanes borrow in list order', () => {
  const candidates = [
    task({ id: 'r1', labels: ['review-pr'] }),
    task({ id: 'r2', labels: ['review-pr'] }),
    task({ id: 'r3', labels: ['review-pr'] }),
    task({ id: 'x', labels: ['other'] }),
  ];
  assert.deepEqual(planStarts({ lanes: LANES, running: [], candidates, ownLaneOf: lane }), [
    { taskId: 'r1', lane: 'reviews', borrowed: false },
    { taskId: 'r2', lane: 'reviews', borrowed: false },
    { taskId: 'r3', lane: 'implement', borrowed: true },
  ]);
  const withImplement = [...candidates, task({ id: 'i1', labels: ['implement'] })];
  assert.deepEqual(
    planStarts({ lanes: LANES, running: [], candidates: withImplement, ownLaneOf: lane }).map(
      (s) => `${s.taskId}:${s.lane}:${s.borrowed}`,
    ),
    ['r1:reviews:false', 'r2:reviews:false', 'i1:implement:false'],
  );
  assert.deepEqual(
    planStarts({
      lanes: LANES,
      running: [run('a', 'reviews', false, 1), run('b', 'reviews', false, 1), run('c', 'implement', true, 1)],
      candidates,
      ownLaneOf: lane,
    }),
    [],
  );
});

test('a full lane with its own work waiting pauses its newest borrowed run that ran long enough', () => {
  const plan = (running: LaneRun[], waiting: Record<string, number>) =>
    planPauses({
      lanes: LANES,
      running,
      waitingOwn: new Map(Object.entries(waiting)),
      now: NOW,
      pauseAfterMinutes: 5,
    }).map((r) => r.taskId);
  assert.deepEqual(plan([run('old', 'reviews', true, 40), run('new', 'reviews', true, 10)], { reviews: 1 }), ['new']);
  assert.deepEqual(
    plan([run('young', 'reviews', true, 3), run('own', 'reviews', false, 30)], { reviews: 1 }),
    [],
    'only after five minutes, never its own work',
  );
  assert.deepEqual(
    plan([run('b', 'reviews', true, 40), run('c', 'reviews', true, 40)], {}),
    [],
    'nothing of its own waits',
  );
  assert.deepEqual(plan([run('b', 'reviews', true, 40)], { reviews: 1 }), [], 'a free slot needs no pause');
  assert.deepEqual(
    plan([run('b', 'reviews', true, 40, true), run('c', 'reviews', true, 40)], { reviews: 2 }),
    [],
    'one pause at a time',
  );
  assert.deepEqual(plan([run('b', 'implement', true, 40)], { implement: 1 }), ['b']);
});

test('decideWake: a timer wakes at its end; a check runs when due, wakes on timeout or when its file is gone', () => {
  const now = at(30);
  const base = { machine: 'here', now };
  assert.equal(decideWake({ ...base, task: { wakeAt: at(31), waitCheck: false }, check: undefined }).kind, 'sleep');
  assert.equal(decideWake({ ...base, task: { wakeAt: at(30), waitCheck: false }, check: undefined }).kind, 'wake');
  const check = { everyMs: 5 * 60_000 };
  assert.equal(decideWake({ ...base, task: { wakeAt: at(50), waitCheck: true }, check }).kind, 'check');
  assert.equal(
    decideWake({ ...base, task: { wakeAt: at(50), waitCheck: true }, check: { ...check, lastCheckAt: at(27) } }).kind,
    'sleep',
  );
  // Twenty seconds early counts: the timer's ticks drift.
  assert.equal(
    decideWake({
      ...base,
      task: { wakeAt: at(50), waitCheck: true },
      check: { ...check, lastCheckAt: new Date(at(25).getTime() + 15_000) },
    }).kind,
    'check',
  );
  assert.equal(decideWake({ ...base, task: { wakeAt: at(29), waitCheck: true }, check }).kind, 'timeout');
  assert.equal(decideWake({ ...base, task: { wakeAt: at(50), waitCheck: true }, check: undefined }).kind, 'wake');
});
