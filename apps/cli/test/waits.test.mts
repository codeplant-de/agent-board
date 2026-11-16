import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWaitStore, runCheck } from '../src/dispatch/waits.mts';

test('the wait store keeps a check per task, private to the user, and drops what it cannot read', () => {
  const dir = mkdtempSync('/tmp/board-waits-test-');
  try {
    const store = createWaitStore(join(dir, 'waits'));
    const createdAt = new Date('2026-01-01T12:00:00Z');
    store.write('Ab3dEf9x', { command: 'gh pr checks 1', cwd: '/w', everyMs: 120_000, createdAt });
    assert.deepEqual(store.read('Ab3dEf9x'), { command: 'gh pr checks 1', cwd: '/w', everyMs: 120_000, createdAt });
    assert.equal(statSync(join(dir, 'waits', 'Ab3dEf9x.json')).mode & 0o777, 0o600);
    store.write('Ab3dEf9x', {
      command: 'x',
      cwd: '/w',
      everyMs: 60_000,
      createdAt,
      lastCheckAt: createdAt,
      lastExit: null,
      lastOutput: 'slow',
    });
    assert.deepEqual(store.read('Ab3dEf9x')?.lastExit, null);
    writeFileSync(join(dir, 'waits', 'broken.json'), '{"command": "", "cwd": "relative"}');
    assert.equal(store.read('broken'), undefined);
    assert.deepEqual(store.list().sort(), ['Ab3dEf9x', 'broken']);
    store.remove('Ab3dEf9x');
    assert.equal(store.read('Ab3dEf9x'), undefined);
    assert.equal(store.read('../etc/passwd'), undefined);
    assert.throws(() => store.write('../x', { command: 'x', cwd: '/w', everyMs: 60_000, createdAt }), /not a task id/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a check runs in its directory with the env of the Claude Code settings, and reports its exit code and output', async () => {
  const dir = mkdtempSync('/tmp/board-waits-test-');
  try {
    const home = join(dir, 'home');
    const work = join(dir, 'work');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(work, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { FROM_USER: 'u', BOTH: 'user' } }));
    writeFileSync(join(work, '.claude', 'settings.local.json'), JSON.stringify({ env: { BOTH: 'project' } }));
    const check = { cwd: work, everyMs: 60_000, createdAt: new Date() };
    const passed = await runCheck({ ...check, command: 'echo "$PWD $FROM_USER $BOTH"' }, home);
    assert.deepEqual(passed, { exitCode: 0, timedOut: false, output: `${work} u project\n` });
    const failed = await runCheck({ ...check, command: 'echo pending >&2; exit 3' }, home);
    assert.deepEqual(failed, { exitCode: 3, timedOut: false, output: 'pending\n' });
    const long = await runCheck({ ...check, command: 'seq 1 5000' }, home);
    assert.ok(long.output.length <= 2000 && long.output.endsWith('4999\n5000\n'));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
