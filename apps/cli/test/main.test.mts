import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { task } from './helpers.mts';

const BIN = fileURLToPath(new URL('../bin/', import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], configDir: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(
      join(BIN, bin),
      args,
      { env: { ...process.env, AGENT_BOARD_CONFIG_DIR: configDir, AGENT_BOARD_TASK: '' }, timeout: 20_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.end();
  });
}

function emptyConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'board-main-test-'));
}

test('help and version need no config file', async () => {
  const dir = emptyConfigDir();
  try {
    const overview = await run('board', [], dir);
    assert.equal(overview.code, 0);
    assert.match(overview.stdout, /Tasks:[\s\S]*Scheduling:[\s\S]*Setup:/);
    for (const args of [['help'], ['-h'], ['--help']]) {
      const result = await run('board', args, dir);
      assert.equal(result.code, 0, args.join(' '));
      assert.equal(result.stdout, overview.stdout);
    }
    for (const args of [
      ['help', 'comment'],
      ['comment', '--help'],
      ['schedule', '-h'],
    ]) {
      const result = await run('board', args, dir);
      assert.equal(result.code, 0, args.join(' '));
      assert.match(result.stdout, /Usage: board /);
    }
    for (const flag of ['--version', '-V']) {
      const result = await run('board', [flag], dir);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /^board \d+\.\d+\.\d+-dev \(contract \d+\)\n$/);
    }
    for (const result of [overview, await run('board', ['--version'], dir)])
      assert.doesNotMatch(result.stderr, /config file missing/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a usage error exits 2 with the usage of its command and a hint', async () => {
  const dir = emptyConfigDir();
  try {
    const result = await run('board', ['schedule', '--hodl', 'x'], dir);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^board: unknown option '--hodl'\n\(Did you mean --hold\?\)\n/);
    assert.match(result.stderr, /usage: board schedule \[options\] <prompt\.\.\.>\n/);
    assert.match(result.stderr, /Run "board help schedule" for the details\.\n$/);
    assert.equal(result.stdout, '');
    assert.equal((await run('board', ['comment', 'abc'], dir)).code, 2);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('an unknown command gets the nearest match', async () => {
  const dir = emptyConfigDir();
  try {
    const result = await run('board', ['taks'], dir);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^board: unknown command 'taks'\n\(Did you mean tasks\?\)\n/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the other entry points keep the agent-board prefix, and the hook never fails', async () => {
  const dir = emptyConfigDir();
  try {
    const worker = await run('worker', ['not/a/task'], dir);
    assert.equal(worker.code, 2);
    assert.match(worker.stderr, /^agent-board: "not\/a\/task" is not a task id\n/);
    const hook = await run('agent-hook', [], dir);
    assert.equal(hook.code, 0);
    assert.match(hook.stderr, /usage: board internal hook/);
    assert.equal(hook.stdout, '');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('tasks works with only web.json and env', async () => {
  const dir = emptyConfigDir();
  const server = createServer((request, response) => {
    const command = request.url?.split('/').pop();
    request.resume();
    request.on('end', () => {
      const result = command === 'version' ? { contract: 5 } : [task({ id: 'Ab3dEf9x', title: 'Fix the thing' })];
      response.end(JSON.stringify({ result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    writeFileSync(join(dir, 'web.json'), JSON.stringify({ url: `http://127.0.0.1:${port}` }));
    writeFileSync(join(dir, 'env'), 'AGENT_BOARD_TOKEN=secret\n', { mode: 0o600 });
    const result = await run('board', ['tasks'], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /todo \(1\)\n {2}Ab3dEf9x {2}normal {2}\[-\] {2}Fix the thing\n/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true });
  }
});
