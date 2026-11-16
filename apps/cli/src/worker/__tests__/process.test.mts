import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { logPath } from '../logs.mts';
import { runProcess } from '../worker.mts';
import type { RunChannel, Watch } from '../worker.mts';

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
      killGraceMs: 300,
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

test('the prompt arrives on stdin as the first user message and adds nothing to the arguments, even when it reads like an option', async () => {
  const prompt = '--mcp-config={"mcpServers":{}}\n- fix the flaky login test';
  await runProcess(
    { command: 'sh', args: ['-c', 'echo "$#"; head -n 1', 'sh'], prompt, cwd: tmpdir() },
    'proc-prompt',
    {},
    QUIET,
  );
  const message = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } });
  assert.equal(readFileSync(logPath('proc-prompt'), 'utf8'), `0\n${message}\n`);
});

// A stand-in for claude: reads user messages, answers an interrupt with the result of the cut-off turn, and says when stdin ends.
const FAKE_AGENT = [
  'read -r prompt',
  'while IFS= read -r line; do',
  '  case "$line" in',
  `    *control_request*) printf '%s\\n' '{"type":"result","subtype":"error_during_execution"}'; sleep 0.4; echo marker;;`,
  `    *second*) echo got-second; printf '%s\\n' '{"type":"result","subtype":"success"}';;`,
  '  esac',
  'done',
  'echo stdin-closed',
].join('\n');

test('stdin closes when a turn ends and nothing is waiting, so the agent exits', async () => {
  const script = `read -r prompt; printf '%s\\n' '{"type":"result","subtype":"success"}'; cat >/dev/null; echo stdin-closed`;
  const result = await runProcess(
    { command: 'sh', args: ['-c', script], prompt: 'go', cwd: tmpdir() },
    'proc-result',
    {},
    QUIET,
  );
  assert.equal(result.exitCode, 0);
  assert.match(readFileSync(logPath('proc-result'), 'utf8'), /stdin-closed/);
});

test('a message sent right after an interrupt keeps stdin open past the interrupted turn, and the next result closes it', async () => {
  const open: boolean[] = [];
  let channel: RunChannel | undefined;
  const result = await runProcess(
    { command: 'sh', args: ['-c', FAKE_AGENT], prompt: 'go', cwd: tmpdir() },
    'proc-carry',
    {},
    {
      everyMs: 50,
      tick: async () => ({ kind: 'continue' }),
      start: (live) => {
        channel = live;
        live.interrupt();
        live.send('second');
      },
    },
    (line) => {
      if (line === 'marker') open.push(channel?.open ?? false);
      return line;
    },
  );
  assert.deepEqual(open, [true], 'the interrupted turn ended and the correction goes on');
  assert.equal(result.exitCode, 0);
  assert.match(readFileSync(logPath('proc-carry'), 'utf8'), /got-second[\s\S]*stdin-closed/);
});

test('an interrupt without a message ends the run after the interrupted turn', async () => {
  const open: boolean[] = [];
  let channel: RunChannel | undefined;
  await runProcess(
    { command: 'sh', args: ['-c', FAKE_AGENT], prompt: 'go', cwd: tmpdir() },
    'proc-interrupt',
    {},
    {
      everyMs: 50,
      tick: async () => ({ kind: 'continue' }),
      start: (live) => {
        channel = live;
        live.interrupt();
      },
    },
    (line) => {
      if (line === 'marker') open.push(channel?.open ?? true);
      return line;
    },
  );
  assert.deepEqual(open, [false]);
  assert.match(readFileSync(logPath('proc-interrupt'), 'utf8'), /stdin-closed/);
});

test('nothing is written after stdin ended', async () => {
  let channel: RunChannel | undefined;
  await runProcess(
    { command: 'sh', args: ['-c', 'cat'], prompt: 'go', cwd: tmpdir() },
    'proc-ended',
    {},
    {
      everyMs: 50,
      tick: async () => ({ kind: 'continue' }),
      start: (live) => {
        channel = live;
        live.end();
        assert.equal(live.send('late'), false);
      },
    },
  );
  assert.equal(channel?.open, false);
  assert.doesNotMatch(readFileSync(logPath('proc-ended'), 'utf8'), /late/);
});

test('a stop from the channel arms the same kill fallback as the watch: an agent that ignores it is terminated', async () => {
  const started = Date.now();
  const result = await runProcess(
    { command: 'sh', args: ['-c', 'sleep 30 & wait'], prompt: 'go', cwd: tmpdir() },
    'proc-channel-stop',
    {},
    { everyMs: 1000, killGraceMs: 300, tick: async () => ({ kind: 'continue' }), start: (live) => live.stop() },
  );
  assert.ok(Date.now() - started < 5_000);
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.stopped, undefined);
});

test('a stop decision interrupts the agent and closes stdin, and the process leaves by itself before the kill', async () => {
  const started = Date.now();
  const result = await runProcess(
    { command: 'sh', args: ['-c', 'cat'], prompt: 'go', cwd: tmpdir() },
    'proc-stop',
    {},
    {
      everyMs: 50,
      killGraceMs: 10_000,
      tick: async () =>
        Date.now() - started > 150 ? { kind: 'stop', why: 'inactive', message: 'quiet' } : { kind: 'continue' },
    },
  );
  assert.equal(result.stopped?.why, 'inactive');
  assert.equal(result.exitCode, 0, 'it ended at the end of its stdin, not by a signal');
  assert.match(readFileSync(logPath('proc-stop'), 'utf8'), /"subtype":"interrupt"/);
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
