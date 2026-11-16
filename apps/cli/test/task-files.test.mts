import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTaskFileStore } from '../src/dispatch/task-files.mts';

test('the task file store lists the logs and session records of tasks, and removes one at a time', () => {
  const dir = mkdtempSync('/tmp/board-task-files-test-');
  try {
    const logDir = join(dir, 'logs');
    const sessionDir = join(dir, 'sessions');
    const store = createTaskFileStore({ logDir, sessionDir });
    assert.deepEqual(store.list(), []);
    mkdirSync(logDir);
    mkdirSync(sessionDir);
    writeFileSync(join(logDir, 'Ab3dEf9x.log'), 'log');
    writeFileSync(join(sessionDir, 'Ab3dEf9x'), 'id\n');
    const when = new Date('2026-01-01T12:00:00Z');
    utimesSync(join(logDir, 'Ab3dEf9x.log'), when, when);
    // Not a task's file: left alone.
    writeFileSync(join(logDir, 'notes.txt'), 'x');
    writeFileSync(join(sessionDir, 'odd.name'), 'x');
    mkdirSync(join(sessionDir, 'Zz9yXw8v'));
    symlinkSync('/etc/passwd', join(logDir, 'Qq7rSt6u.log'));
    const listed = store.list().map((file) => `${file.kind} ${file.taskId}`);
    assert.deepEqual(listed.sort(), ['log Ab3dEf9x', 'session Ab3dEf9x']);
    assert.deepEqual(store.list().find((file) => file.kind === 'log')?.modifiedAt, when);
    store.remove({ kind: 'log', taskId: 'Ab3dEf9x' });
    assert.ok(!existsSync(join(logDir, 'Ab3dEf9x.log')));
    assert.ok(existsSync(join(sessionDir, 'Ab3dEf9x')));
    store.remove({ kind: 'session', taskId: 'Ab3dEf9x' });
    assert.deepEqual(store.list(), []);
    assert.throws(() => store.remove({ kind: 'log', taskId: '../x' }), /not a task id/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
