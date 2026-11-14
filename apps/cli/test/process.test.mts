import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { logPath } from '../src/logs.mts';
import { runProcess } from '../src/worker.mts';
import type { Watch } from '../src/worker.mts';

// A killed process nobody has reaped yet (a zombie, as when the container's init reaps late) still answers kill(pid, 0).
function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!isGone(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return isGone(pid);
}

const QUIET: Watch = { everyMs: 50, tick: async () => ({ kind: 'continue' }) };

process.env['AGENT_BOARD_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'agent-board-state-'));

test('a finished process reports its exit code and writes its log', async () => {
  const result = await runProcess(
    { command: 'sh', args: ['-c', 'echo hello; exit 3'], prompt: '', cwd: tmpdir() },
    'proc1',
    {},
    QUIET,
  );
  assert.deepEqual(result, { exitCode: 3, signal: null });
  assert.match(readFileSync(logPath('proc1'), 'utf8'), /hello/);
});

test('a process the watch stops is ended with everything it started', async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), 'agent-board-pid-')), 'child.pid');
  const started = Date.now();
  const result = await runProcess(
    { command: 'sh', args: ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], prompt: '', cwd: tmpdir() },
    'proc2',
    {},
    {
      everyMs: 100,
      tick: async () =>
        Date.now() - started > 400 ? { kind: 'stop', why: 'inactive', message: 'quiet' } : { kind: 'continue' },
    },
  );
  assert.equal(result.stopped?.why, 'inactive');
  assert.ok(Date.now() - started < 5_000);
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(grandchild > 0);
  assert.ok(await waitUntilGone(grandchild, 3_000), 'the grandchild must be dead');
});

test('the prompt arrives on stdin and adds nothing to the arguments, even when it reads like an option', async () => {
  const prompt = '--mcp-config={"mcpServers":{}}\n- fix the flaky login test';
  await runProcess(
    { command: 'sh', args: ['-c', 'echo "$#"; cat', 'sh'], prompt, cwd: tmpdir() },
    'proc-prompt',
    {},
    QUIET,
  );
  assert.equal(readFileSync(logPath('proc-prompt'), 'utf8'), `0\n${prompt}\n`);
});

test('a process that never reads its prompt does not break the worker', async () => {
  const result = await runProcess(
    { command: 'sh', args: ['-c', 'exit 0'], prompt: 'x'.repeat(1_000_000), cwd: tmpdir() },
    'proc-noread',
    {},
    QUIET,
  );
  assert.equal(result.exitCode, 0);
});

test('a missing command rejects', async () => {
  await assert.rejects(
    runProcess({ command: 'no-such-command-xyz', args: [], prompt: '', cwd: tmpdir() }, 'proc3', {}, QUIET),
    /could not start/,
  );
});

test('extra environment reaches the process, and the rest of the environment stays', async () => {
  process.env['AGENT_BOARD_TEST_KEPT'] = 'kept';
  await runProcess(
    { command: 'sh', args: ['-c', 'echo $AGENT_BOARD_TEST_EXTRA $AGENT_BOARD_TEST_KEPT'], prompt: '', cwd: tmpdir() },
    'proc4',
    { AGENT_BOARD_TEST_EXTRA: 'extra' },
    QUIET,
  );
  assert.match(readFileSync(logPath('proc4'), 'utf8'), /extra kept/);
});

test('stdout goes line by line through onLine into the log; stderr goes straight in', async () => {
  const seen: string[] = [];
  await runProcess(
    { command: 'sh', args: ['-c', "printf 'one\\ntwo\\nlast'; echo oops >&2"], prompt: '', cwd: tmpdir() },
    'proc5',
    {},
    QUIET,
    (line) => {
      seen.push(line);
      return line === 'two' ? undefined : `[${line}]`;
    },
  );
  assert.deepEqual(seen, ['one', 'two', 'last'], 'a last line without a newline still counts');
  const log = readFileSync(logPath('proc5'), 'utf8');
  assert.match(log, /\[one\]/);
  assert.doesNotMatch(log, /two/);
  assert.match(log, /\[last\]/);
  assert.match(log, /oops/);
});
