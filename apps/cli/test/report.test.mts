import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendToNeedsMe } from '../src/report.mts';
import { fakeBackend, task } from './helpers.mts';

function setup(status: 'running' | 'needs-me') {
  const backend = fakeBackend([task({ id: 'a', status })]);
  const notified: string[] = [];
  const printed: string[] = [];
  const deps = {
    backend,
    print: (line: string) => void printed.push(line),
    notify: async (_task: unknown, text: string) => void notified.push(text),
  };
  return { backend, notified, printed, deps };
}

test('a running task goes to Needs me with the text, and Slack hears of it', async () => {
  const { backend, notified, deps } = setup('running');
  await sendToNeedsMe(deps, backend.tasks[0]!, 'It broke');
  assert.deepEqual(backend.writes, ['fail a: It broke']);
  assert.deepEqual(notified, ['It broke']);
});

test('a task that is no longer running is left alone and not announced', async () => {
  const { backend, notified, deps } = setup('needs-me');
  await sendToNeedsMe(deps, backend.tasks[0]!, 'It broke');
  assert.deepEqual(notified, []);
  assert.equal(backend.tasks[0]!.status, 'needs-me');
});

test('a failed Slack post is only a warning', async () => {
  const { backend, printed, deps } = setup('running');
  await sendToNeedsMe(
    { ...deps, notify: async () => Promise.reject(new Error('hook gone')) },
    backend.tasks[0]!,
    'It broke',
  );
  assert.deepEqual(printed, ['WARN notify failed: hook gone']);
});
