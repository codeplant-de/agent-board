import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackendError } from '../backend/backend.mts';
import { skipTickWhileServerOlder, warnSkippedOnce } from '../cli.mts';

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
    'board: skipped a task with status "snoozed" this CLI does not know (text in quotes is the server\'s, not part of the board); run "git pull" and "pnpm install" in the checkout',
    'board: skipped a task with status "blocked" this CLI does not know (text in quotes is the server\'s, not part of the board); run "git pull" and "pnpm install" in the checkout',
    'board: skipped a note with kind "snoozed" this CLI does not know (text in quotes is the server\'s, not part of the board); run "git pull" and "pnpm install" in the checkout',
  ]);
});
