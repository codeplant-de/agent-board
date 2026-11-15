import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendError } from '../src/backend.mts';
import { skipTickWhileServerOlder, warnSkippedOnce } from '../src/cli.mts';
import { runIntake } from '../src/intake.mts';
import { CONFIG, fakeBackend } from './helpers.mts';

const serverOlder = (): BackendError =>
  Object.assign(new BackendError('the board server is older than this CLI: it speaks API 6'), {
    contractMismatch: 'server-older' as const,
  });

test('a tick against an older server logs one line and ends without a failure', async () => {
  const lines: string[] = [];
  await skipTickWhileServerOlder(
    async () => {
      throw serverOlder();
    },
    (line) => lines.push(line),
  );
  assert.deepEqual(lines, ['skipped: the board server is older than this CLI: it speaks API 6']);
});

test('an intake tick against an older server is skipped as well', async () => {
  const backend = fakeBackend([]);
  backend.listTasks = async () => {
    throw serverOlder();
  };
  const lines: string[] = [];
  await skipTickWhileServerOlder(
    () =>
      runIntake({
        backend,
        config: CONFIG,
        dryRun: false,
        print: (line) => lines.push(line),
        github: { listReviewRequested: async () => ({ prs: [], unreadable: [] }) } as never,
        now: () => new Date(),
      }),
    (line) => lines.push(line),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /^skipped: the board server is older/);
});

test('every other failure of a tick still fails it', async () => {
  const fails = (error: Error) =>
    skipTickWhileServerOlder(
      async () => Promise.reject(error),
      () => undefined,
    );
  await assert.rejects(fails(new Error('boom')), /boom/);
  await assert.rejects(fails(new BackendError('refused', 401, true)), /refused/);
  await assert.rejects(
    fails(Object.assign(new BackendError('cli old'), { contractMismatch: 'cli-older' as const })),
    /cli old/,
  );
});

test('a skipped item is warned about once per field and value', () => {
  const lines: string[] = [];
  const warn = warnSkippedOnce((line) => lines.push(line));
  warn({ what: 'task', field: 'status', value: 'snoozed' });
  warn({ what: 'task', field: 'status', value: 'snoozed' });
  warn({ what: 'task', field: 'status', value: 'blocked' });
  warn({ what: 'note', field: 'kind', value: 'snoozed' });
  assert.deepEqual(lines, [
    'board: skipped a task with status "snoozed" this CLI does not know; run "git pull" and "pnpm install" in the checkout',
    'board: skipped a task with status "blocked" this CLI does not know; run "git pull" and "pnpm install" in the checkout',
    'board: skipped a note with kind "snoozed" this CLI does not know; run "git pull" and "pnpm install" in the checkout',
  ]);
});
