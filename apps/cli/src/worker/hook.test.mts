import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRunFiles } from './runtime.mts';

test('run files: lane record, heartbeat, pause request, clear', () => {
  const files = createRunFiles(join(mkdtempSync(join(tmpdir(), 'agent-board-run-')), 'agent-board'));
  const at = new Date('2026-11-13T10:00:00Z');
  files.writeRun('t1', { lane: 'reviews', borrowed: true, startedAt: at });
  assert.deepEqual(files.readRun('t1'), { lane: 'reviews', borrowed: true, startedAt: at });
  assert.equal(files.lastActive('t1'), undefined);
  files.touchAlive('t1', at);
  assert.equal(files.lastActive('t1')?.getTime(), at.getTime());
  files.requestPause('t1');
  assert.ok(files.pauseRequestedAt('t1'));
  assert.equal((statSync(files.dir).mode & 0o777).toString(8), '700');
  files.clear('t1');
  assert.deepEqual(
    [files.readRun('t1'), files.lastActive('t1'), files.pauseRequestedAt('t1')],
    [undefined, undefined, undefined],
  );
});

test("run files keep the agent's last working directory", () => {
  const files = createRunFiles(join(mkdtempSync(join(tmpdir(), 'agent-board-run-')), 'agent-board'));
  assert.equal(files.lastCwd('t1'), undefined);
  files.writeCwd('t1', '/repo/.claude/worktrees/feat-x');
  assert.equal(files.lastCwd('t1'), '/repo/.claude/worktrees/feat-x');
  files.clear('t1');
  assert.equal(files.lastCwd('t1'), undefined);
});
