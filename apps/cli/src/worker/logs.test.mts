import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendLog, closeLog, logPath, openLog, readLogTail, resetLog } from './logs.mts';

function withStateDir(run: (stateDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-logs-'));
  const before = process.env['AGENT_BOARD_STATE_DIR'];
  process.env['AGENT_BOARD_STATE_DIR'] = dir;
  try {
    run(dir);
  } finally {
    if (before === undefined) delete process.env['AGENT_BOARD_STATE_DIR'];
    else process.env['AGENT_BOARD_STATE_DIR'] = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a log lives in the logs folder of the state dir, named for its task', () => {
  withStateDir((dir) => {
    assert.equal(logPath('t1'), join(dir, 'logs', 't1.log'));
  });
});

test('opening a log creates its folder for the owner only and the file readable by the owner only', () => {
  withStateDir((dir) => {
    closeLog(openLog('t1'));
    assert.equal(statSync(join(dir, 'logs')).mode & 0o777, 0o700);
    assert.equal(statSync(logPath('t1')).mode & 0o777, 0o600);
  });
});

test('a log opened for appending keeps what it has, and one opened for writing starts empty', () => {
  withStateDir(() => {
    resetLog('t1');
    appendLog('t1', 'one');
    closeLog(openLog('t1'));
    assert.equal(readFileSync(logPath('t1'), 'utf8'), '\none\n');
    closeLog(openLog('t1', 'w'));
    assert.equal(readFileSync(logPath('t1'), 'utf8'), '');
  });
});

test('resetLog truncates an existing log and creates a missing one', () => {
  withStateDir(() => {
    appendLog('t1', 'unreachable: no folder yet');
    assert.equal(existsSync(logPath('t1')), false);
    resetLog('t1');
    assert.equal(readFileSync(logPath('t1'), 'utf8'), '');
    appendLog('t1', 'old run');
    resetLog('t1');
    assert.equal(readFileSync(logPath('t1'), 'utf8'), '');
  });
});

test('appendLog adds the text on its own line to the log, and does not throw when the folder is missing', () => {
  withStateDir(() => {
    assert.doesNotThrow(() => appendLog('t1', 'lost'));
    resetLog('t1');
    appendLog('t1', 'one');
    appendLog('t1', 'two');
    assert.equal(readFileSync(logPath('t1'), 'utf8'), '\none\n\ntwo\n');
  });
});

test('readLogTail gives an empty string for a log that does not exist', () => {
  withStateDir(() => {
    assert.equal(readLogTail('nope'), '');
  });
});

test('readLogTail gives a short log trimmed and a long one as its last 4000 characters led by an ellipsis', () => {
  withStateDir(() => {
    resetLog('t1');
    appendLog('t1', 'short');
    assert.equal(readLogTail('t1'), 'short');
    const long = `${'a'.repeat(5000)}END`;
    writeFileSync(logPath('t1'), long);
    const result = readLogTail('t1');
    assert.equal(result.length, 4000);
    assert.ok(result.startsWith('…a'));
    assert.ok(result.endsWith('aEND'));
  });
});
