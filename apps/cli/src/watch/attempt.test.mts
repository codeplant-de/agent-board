import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandDef, commandResult, HEAD, PR, timerDef, watchDef } from '../__tests__/helpers/watch.mts';
import { localTime } from '../commands/schedule.mts';
import { attempt, deadlineReport, nextAttemptAt, timeoutText } from './attempt.mts';
import type { RunJob, WatchRunner } from './attempt.mts';

const NOW = new Date('2026-01-01T12:01:00Z');

function runner(answer: (job: RunJob) => ReturnType<typeof commandResult>): WatchRunner & { jobs: RunJob[] } {
  const jobs: RunJob[] = [];
  const run = Object.assign(
    async (job: RunJob) => {
      jobs.push(job);
      return answer(job);
    },
    { jobs },
  );
  return run;
}

test('a command watch ends on exit 0 with the end of its output, and otherwise stays pending with its exit code', async () => {
  const done = await attempt(commandDef('true'), NOW, {
    run: runner(() => commandResult(0, 'ready\n')),
    timeLimitMs: 1000,
  });
  assert.deepEqual(done, { kind: 'event', text: 'Exit 0. End of its output:\nready' });
  const quiet = await attempt(commandDef('true'), NOW, { run: runner(() => commandResult(0)), timeLimitMs: 1000 });
  assert.deepEqual(quiet, { kind: 'event', text: 'Exit 0. It printed nothing.' });
  const waiting = await attempt(commandDef('false'), NOW, {
    run: runner(() => commandResult(3, 'not yet\n')),
    timeLimitMs: 1000,
  });
  assert.deepEqual(waiting, { kind: 'pending', summary: 'exit 3: not yet' });
  const slow = await attempt(commandDef('sleep 9'), NOW, {
    run: runner(() => commandResult(null, '', { timedOut: true })),
    timeLimitMs: 1000,
  });
  assert.deepEqual(slow, { kind: 'pending', summary: 'too slow, stopped' });
});

test('a command runs in its directory with its settings and the time limit it was given', async () => {
  const run = runner(() => commandResult(1));
  const def = commandDef('curl -f x', {
    source: { kind: 'command', command: 'curl -f x', cwd: '/w', settingsDir: '/s' },
  });
  const controller = new AbortController();
  await attempt(def, NOW, { run, timeLimitMs: 45_000, signal: controller.signal });
  assert.deepEqual(run.jobs, [
    { command: 'curl -f x', cwd: '/w', settingsDir: '/s', timeLimitMs: 45_000, signal: controller.signal },
  ]);
});

test('at registration a command that cannot run here is broken; later it is just pending', async () => {
  for (const code of [126, 127, null]) {
    const run = runner(() => commandResult(code, 'bash: nope: command not found\n'));
    const first = await attempt(commandDef('nope'), NOW, { run, timeLimitMs: 1000, registration: true });
    assert.equal(first.kind, 'broken', String(code));
    assert.match(first.kind === 'broken' ? first.reason : '', /command not found/);
    assert.equal((await attempt(commandDef('nope'), NOW, { run, timeLimitMs: 1000 })).kind, 'pending');
  }
  const failing = runner(() => commandResult(1, 'down'));
  assert.equal(
    (await attempt(commandDef('x'), NOW, { run: failing, timeLimitMs: 1000, registration: true })).kind,
    'pending',
  );
  const slow = runner(() => commandResult(null, '', { timedOut: true }));
  assert.equal(
    (await attempt(commandDef('x'), NOW, { run: slow, timeLimitMs: 1000, registration: true })).kind,
    'pending',
  );
});

// A gh that knows one PR.
const gh = (view: unknown, checks: unknown) =>
  runner((job) => {
    if (job.command.startsWith('gh pr view')) return commandResult(0, JSON.stringify(view));
    return commandResult(0, JSON.stringify(checks));
  });
const open = { url: PR, headRefOid: HEAD, state: 'OPEN' };

test('a ci watch asks gh for the PR and its checks in its directory, with --required when it asked for it', async () => {
  const run = gh(open, [{ name: 'a', bucket: 'pending', link: '' }]);
  const def = watchDef({ source: { kind: 'ci', pr: PR, required: true, cwd: '/w', settingsDir: '/s' } });
  const result = await attempt(def, NOW, { run, timeLimitMs: 120_000 });
  assert.deepEqual(
    run.jobs.map((job) => [job.command, job.cwd, job.settingsDir, job.timeLimitMs]),
    [
      [`gh pr view '${PR}' --json url,headRefOid,state`, '/w', '/s', 60_000],
      [`gh pr checks '${PR}' --required --json name,bucket,link`, '/w', '/s', 60_000],
    ],
  );
  assert.equal(result.kind === 'pending' && result.summary, '0 of 1 passed, 1 running');
  // The watched head comes back on the definition for the caller to store.
  assert.equal(result.kind === 'pending' && result.def?.source.kind === 'ci' && result.def.source.head, HEAD);
});

test('a ci watch does not ask for the checks of a PR that is not open', async () => {
  const run = gh({ ...open, state: 'MERGED' }, []);
  const result = await attempt(watchDef(), NOW, { run, timeLimitMs: 120_000 });
  assert.deepEqual(result, { kind: 'event', text: `PR ${PR} was merged.` });
  assert.equal(run.jobs.length, 1);
});

test('a ci watch whose gh fails is pending, and at registration broken', async () => {
  const run = runner(() => commandResult(1, 'HTTP 404: Not Found\n'));
  const later = await attempt(watchDef(), NOW, { run, timeLimitMs: 1000 });
  assert.deepEqual(later, { kind: 'pending', summary: 'HTTP 404: Not Found' });
  const first = await attempt(watchDef(), NOW, { run, timeLimitMs: 1000, registration: true });
  assert.deepEqual(first, { kind: 'broken', reason: 'HTTP 404: Not Found' });
});

test('the ci call limit follows a shorter attempt limit', async () => {
  const run = gh(open, [{ name: 'a', bucket: 'pending', link: '' }]);
  await attempt(watchDef(), NOW, { run, timeLimitMs: 45_000 });
  assert.deepEqual(
    run.jobs.map((job) => job.timeLimitMs),
    [45_000, 45_000],
  );
});

test('a timer is never run: its end is its event', async () => {
  const run = runner(() => commandResult(0));
  const def = timerDef({ deadline: '2026-01-01T12:20:00.000Z' });
  assert.equal((await attempt(def, NOW, { run, timeLimitMs: 1000 })).kind, 'pending');
  const over = await attempt(def, new Date('2026-01-01T12:20:00Z'), { run, timeLimitMs: 1000 });
  assert.deepEqual(over, { kind: 'event', text: `Time is up (set ${localTime(new Date('2026-01-01T12:00:00Z'))}).` });
  assert.equal(run.jobs.length, 0);
});

test('a watch past its deadline times out, naming its last attempt or that it never ran', () => {
  const never = commandDef('true');
  assert.equal(
    timeoutText(never),
    `Watch "health" timed out after 2h (${localTime(new Date(never.deadline))}). It never ran.`,
  );
  const ran = commandDef('true', { last: { at: '2026-01-01T13:59:30.000Z', summary: 'exit 1: down' } });
  assert.equal(
    timeoutText(ran),
    `Watch "health" timed out after 2h (${localTime(new Date(ran.deadline))}). Last attempt ${localTime(new Date('2026-01-01T13:59:30Z'))}: exit 1: down`,
  );
  assert.equal(deadlineReport(ran).kind, 'timeout');
  assert.equal(deadlineReport(timerDef()).kind, 'event');
});

test('the next attempt is due one period after the last, or after registration, which ran the first', () => {
  const def = commandDef('true', { everyMs: 60_000 });
  assert.equal(nextAttemptAt(def), Date.parse('2026-01-01T12:01:00Z'));
  assert.equal(
    nextAttemptAt({ ...def, last: { at: '2026-01-01T12:05:00.000Z', summary: '' } }),
    Date.parse('2026-01-01T12:06:00Z'),
  );
});
