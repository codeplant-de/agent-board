import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRunFiles } from './runtime.mts';

test("an agent's definition is written private to the user, next to the task's other run files, and goes with the run", () => {
  const dir = mkdtempSync(join(tmpdir(), 'board-run-'));
  try {
    const files = createRunFiles(join(dir, 'run'));
    files.writeAgents('abc', '{"reviewer":{}}');
    const path = files.agentsPath('abc');
    assert.equal(path, join(dir, 'run', 'abc.agents'));
    assert.equal(readFileSync(path, 'utf8'), '{"reviewer":{}}');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'run')).mode & 0o777, 0o700);
    files.clear('abc');
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
