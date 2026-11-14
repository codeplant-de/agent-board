import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSessionStore } from '../src/sessions.mts';
import { OTHER_SESSION, SESSION } from './helpers.mts';

function withDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-sessions-'));
  try {
    run(join(dir, 'sessions'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a session is known for the task it was recorded for, case-insensitively, and for no other', () => {
  withDir((dir) => {
    const store = createSessionStore(dir);
    assert.equal(store.has('t1', SESSION), false);
    store.record('t1', SESSION);
    store.record('t2', OTHER_SESSION);
    assert.equal(store.has('t1', SESSION), true);
    assert.equal(store.has('t1', SESSION.toUpperCase()), true);
    assert.equal(store.has('t1', OTHER_SESSION), false);
    assert.equal(store.has('t2', SESSION), false);
    assert.equal(createSessionStore(dir).has('t1', SESSION), true, 'kept on disk');
    assert.equal(statSync(join(dir, 't1')).mode & 0o777, 0o600);
  });
});

test('only UUIDs and safe task ids go in or out, and a damaged record reads as empty', () => {
  withDir((dir) => {
    const store = createSessionStore(dir);
    assert.throws(() => store.record('t1', '--dangerously-skip-permissions'), /not a session id/);
    assert.throws(() => store.record('../x', SESSION), /not a task id/);
    assert.throws(() => store.has('dispatch', SESSION), /not a task id/);
    store.record('t1', SESSION);
    writeFileSync(join(dir, 't1'), `--resume\n${SESSION}\n\nnot a uuid\n`);
    assert.equal(store.has('t1', SESSION), true);
    assert.equal(store.has('t1', '--resume'), false);
  });
});

test('only the newest sessions of a task are kept', () => {
  withDir((dir) => {
    const store = createSessionStore(dir);
    const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
    for (let n = 0; n < 60; n++) store.record('t1', id(n));
    assert.equal(store.has('t1', id(0)), false);
    assert.equal(store.has('t1', id(59)), true);
    assert.ok(readFileSync(join(dir, 't1'), 'utf8').split('\n').filter(Boolean).length <= 50);
  });
});
